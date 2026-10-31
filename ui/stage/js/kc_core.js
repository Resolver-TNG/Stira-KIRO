// Stira-KIRO: the chat core the Stage's talk.js uses, on KiroCrew's chat API.
//
// talk.js was written for StiraCore's own chat server (window.StiraChatCore, chat_core.js).
// This module keeps chat_core's pure helpers (keys, images, gauge, wording) and replaces the
// parts that talk to a server:
//   createSender        POST /api/chat {slot, message}  -> SSE `data: {type, content, ...}` ... `data: [DONE]`
//   fetchConversation   GET  /api/chat/slots/{slot}?limit=N -> turns [{turn_id, message, response}]
//   createSessionStarter  a new conversation = a new KiroCrew session (slot), remembered here
// The slot is a normal KiroCrew session (it shows in the sidebar), created on the first send.

import { extractOptions } from './kc_widget.js';

const SLOT_STORE = 'stira.kiro.slot';
const HISTORY_LIMIT = 50;

// Told to the agent once per page (KiroCrew silent context: rides with the next message only,
// shows nowhere). Short on purpose: it is paid for in tokens.
export const STAGE_HINT =
  '[Stira Stage] The user is talking to you from Stira Stage (a pixel-art room with a text window and a whiteboard). ' +
  'Answer in the language the user writes in, and keep the spoken lines short. When a diagram or picture helps, put it ' +
  'in the reply as a ```svg code block or an <mcwidget> (do not save image files unless asked). ' +
  'A final [OPTIONS: a | b] line is shown as buttons.';

function tr(t, key, vars) {
  return typeof t === 'function' ? t(key, vars) : key;
}

function newSlotKey() {
  return `stira-stage-${Date.now().toString(36)}`;
}

function storedSlot() {
  try {
    const v = localStorage.getItem(SLOT_STORE);
    return v && /^[A-Za-z0-9_.:-]{1,120}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

function storeSlot(key) {
  try {
    localStorage.setItem(SLOT_STORE, key);
  } catch {
    /* storage refused: this page keeps the key in memory */
  }
}

// One SSE reader for KiroCrew's frames: `data: <json>` rows, `data: [DONE]` at the end,
// `: keepalive` comments in between. onFrame(frame) per JSON row; resolves true at [DONE].
async function readFrames(response, onFrame) {
  const ctype = response.headers.get('content-type') || '';
  if (!response.body || !ctype.includes('text/event-stream')) throw new Error('missing event stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let m;
      while ((m = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        if (data === '[DONE]') return true;
        let frame;
        try {
          frame = JSON.parse(data);
        } catch {
          continue;
        }
        if (frame && typeof frame === 'object') onFrame(frame);
      }
      if (done) return false;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

// A tool row's short name for the narration: the first identifier-like word, never free text.
function toolName(content) {
  const s = typeof content === 'string' ? content : '';
  const m = /[A-Za-z_][\w.:-]{1,48}/.exec(s);
  return m ? m[0] : 'tool';
}

function toolKindOf(name, content) {
  const s = `${name} ${typeof content === 'string' ? content.slice(0, 200) : ''}`;
  if (/memory|knowledge|recall|stira_|lesson/i.test(s)) return 'memory';
  if (/web_fetch|web_search|https?:\/\//i.test(s)) return 'web';
  return 'tool';
}

export function makeCore(base, { fetch: apiFetch }) {
  if (!base) throw new Error('chat_core.js is not loaded');
  const slot = { key: storedSlot(), created: false };

  async function ensureSlot() {
    if (!slot.key) {
      slot.key = newSlotKey();
      storeSlot(slot.key);
    }
    if (slot.created) return slot.key;
    const r = await apiFetch('/api/chat/slots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: slot.key, title: 'Stira Stage' }),
    });
    // 409: it already exists (another tab, an earlier visit) — that is the one we want
    if (!r.ok && r.status !== 409) throw new Error(`session ${r.status}`);
    slot.created = true;
    await hint(slot.key);
    return slot.key;
  }

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  async function pushContext(key, content, source) {
    await apiFetch(`/api/chat/slots/${encodeURIComponent(key)}/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, source, ephemeral: true }),
    });
  }

  // best effort: a refused hint never blocks the conversation.
  // セッションの最初に、Stage の説明と記憶の目次(backend/recall.py brief)を1回だけ渡す。
  async function hint(key) {
    if (slot.hinted === key) return;
    slot.hinted = key;
    let index = '';
    try {
      const r = await withTimeout(apiFetch('/api/apps/stira-kiro/memory/brief', { cache: 'no-store' }), 1500);
      if (r.ok) index = String((await r.json()).text || '');
    } catch {
      /* no index: the hint alone */
    }
    try {
      await pushContext(key, index ? `${STAGE_HINT}\n${index}` : STAGE_HINT, 'stira-stage');
    } catch {
      /* the agent just does not know it is on the Stage */
    }
  }

  // 送る文ごとに、関係する章と葉を探して、その1通にだけ添える(見つからなければ何もしない)
  async function recallFor(key, message) {
    try {
      const r = await withTimeout(apiFetch('/api/apps/stira-kiro/memory/relevant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: String(message || '').slice(0, 4000) }),
      }), 1500);
      if (!r.ok) return [];
      const body = await r.json();
      if (!body.context || !Array.isArray(body.hits) || !body.hits.length) return [];
      await pushContext(key, body.context, 'stira-recall');
      return body.hits;
    } catch {
      return [];
    }
  }

  function createSender({ fetch, t }) {
    let unsettled = null;
    let controller = null;
    let stopped = false;
    return {
      get unsettled() {
        return unsettled;
      },
      get busy() {
        return controller !== null;
      },
      blocked(payload) {
        return Boolean(unsettled && unsettled.body !== payload);
      },
      discard() {
        unsettled = null;
      },
      stop() {
        if (!controller) return false;
        stopped = true;
        controller.abort();
        return true;
      },
      async send({ message, images = [], payload = base.payloadOf(message, images) }, on = {}) {
        if (base.commandOf(message)) {
          return { ok: false, completed: false, delivery: 'refused', stopped: false, command: 'new', error: new Error(tr(t, 'chat.new_not_a_message')), key: null };
        }
        if (!unsettled || unsettled.body !== payload) unsettled = { body: payload, key: base.newKey(), message, images };
        const key = unsettled.key;
        controller = new AbortController();
        stopped = false;
        let completed = false;
        let delivery = 'unknown';
        let failure = null;
        let chunks = '';
        let segment = '';
        let finalText = null;
        let toolSeq = 0;
        let openTool = null;
        const turnId = `kc-${Date.now().toString(36)}`;
        const ui = (data) => {
          try {
            on.uiEvent?.(data);
          } catch {
            /* the page's own handler */
          }
        };
        const endTool = (ok = true) => {
          if (openTool) ui({ type: 'tool.ended', id: openTool, ok });
          openTool = null;
        };
        try {
          const slotKey = await ensureSlot();
          let body;
          try {
            body = { ...JSON.parse(payload), slot: slotKey };
          } catch {
            body = { message, slot: slotKey };
          }
          const hits = await recallFor(slotKey, body.message);
          if (hits.length) ui({ type: 'recall.used', items: hits.map((h) => ({ type: h.type, title: h.title, chapter: h.chapter })) });
          delete body.images; // M1: no attachments on the Stage
          delete body.progress_reply; // StiraCore's field (an option pressed): plain text here
          const response = await (fetch || apiFetch)('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            if (response.status >= 400 && response.status < 500) delivery = 'refused';
            throw new Error(err.error || tr(t, 'chat.request_failed_status', { status: response.status }));
          }
          ui({ type: 'turn.started', turn_id: turnId });
          const ended = await readFrames(response, (frame) => {
            const type = frame.type;
            const content = typeof frame.content === 'string' ? frame.content : '';
            if (type === 'chunk') {
              chunks += content;
              segment += content;
              on.delta?.({ text: content });
            } else if (type === 'assistant') {
              finalText = content;
            } else if (type === 'tool') {
              // text before a tool call is a working note: the page starts the reply over
              if (segment) ui({ type: 'segment.reset' });
              segment = '';
              endTool(true);
              toolSeq += 1;
              openTool = `${turnId}-t${toolSeq}`;
              const name = toolName(content);
              ui({ type: 'tool.started', id: openTool, name, kind: toolKindOf(name, content) });
            } else if (type === 'error') {
              failure = content || tr(t, 'chat.response_failed');
            }
          });
          endTool(!failure);
          if (!ended) throw new Error(tr(t, 'chat.response_interrupted'));
          completed = true;
          // A reply that came only as its final row (no token chunks), or more than the chunks
          // carried: the page gets the rest as one more delta.
          // (with chunks, the chunks are the reply; the final rows may hold the whole turn)
          if (typeof finalText === 'string' && finalText && !chunks) on.delta?.({ text: finalText });
          if (failure) {
            const e = new Error(failure);
            e.code = 'model_failure';
            throw e;
          }
          const options = extractOptions(segment || finalText || chunks);
          if (options.length) ui({ type: 'options', items: options });
          on.turn?.({ turn_id: turnId });
          unsettled = null;
          return { ok: true, completed, delivery: 'delivered', stopped: false, error: null, key };
        } catch (error) {
          endTool(false);
          if (completed || delivery !== 'unknown' || error.code === 'model_failure') unsettled = null;
          return { ok: false, completed, delivery, stopped: stopped && !completed, error, key };
        } finally {
          ui({ type: 'turn.ended', turn_id: turnId, ok: !failure && !stopped });
          controller = null;
        }
      },
    };
  }

  async function fetchConversation() {
    if (!slot.key) return { turns: [], session: null };
    const r = await apiFetch(`/api/chat/slots/${encodeURIComponent(slot.key)}?limit=${HISTORY_LIMIT}`, { cache: 'no-store' });
    if (r.status === 404) {
      slot.created = false;
      return { turns: [], session: { id: slot.key, reason: 'start', startedAt: null, cleared: 0, request: null } };
    }
    if (!r.ok) throw new Error(String(r.status));
    slot.created = true;
    const body = await r.json();
    const rows = Array.isArray(body && body.messages) ? body.messages : Array.isArray(body && body.history) ? body.history : [];
    const turns = [];
    let cur = null;
    for (const row of rows) {
      if (!row || typeof row.content !== 'string') continue;
      const mid = row.meta && typeof row.meta.mid === 'string' ? row.meta.mid : null;
      if (row.role === 'user') {
        cur = { turn_id: mid || `u-${turns.length}`, message: row.content, response: '' };
        turns.push(cur);
      } else if (row.role === 'assistant' && cur) {
        cur.response = cur.response ? `${cur.response}\n\n${row.content}` : row.content;
      }
    }
    return { turns: turns.slice(-HISTORY_LIMIT), session: { id: slot.key, reason: 'start', startedAt: null, cleared: 0, request: null } };
  }

  function createSessionStarter() {
    const starter = {
      pendingKey: null,
      running: false,
      async start() {
        starter.running = true;
        try {
          const key = newSlotKey();
          const r = await apiFetch('/api/chat/slots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: key, title: 'Stira Stage' }),
          });
          if (!r.ok) return { ok: false, outcome: 'refused', error: new Error(`session ${r.status}`) };
          slot.key = key;
          slot.created = true;
          storeSlot(key);
          await hint(key);
          return { ok: true, outcome: 'started', session: { id: key, reason: 'new', startedAt: Date.now() / 1000, current: true } };
        } catch (error) {
          return { ok: false, outcome: 'refused', error };
        } finally {
          starter.running = false;
        }
      },
      resolve: null,
    };
    return starter;
  }

  return {
    ...base,
    createSender,
    fetchConversation,
    fetchHistory: async () => (await fetchConversation()).turns,
    createSessionStarter,
    slotKey: () => slot.key,
  };
}
