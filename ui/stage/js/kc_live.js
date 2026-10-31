// Stira-KIRO: the Stage's live controller on KiroCrew.
//
// StiraCore's live_ui.js polls Stira's own APIs (Neural State, turns, approvals). On KiroCrew the
// Stage learns what happens from the conversation it runs itself: kc_core.js turns the chat
// stream into turn / tool events and talk.js hands them here (ingestTurnEvent). They become the
// model's events (turn.start, tool.start, tool.end, turn.end), so the room, the props and the
// narration follow real events only — the Stage's rule "nothing is decoration".
//
// This is also the one entry point for later sources (memory events: recall, harvest, a leaf
// planted): they arrive as ingestTurnEvent({type, ...}) and map to model events below.
//
// No approvals here: KiroCrew owns tool approval (YOLO or its own cards); Stira-KIRO adds none.

import { narrate } from './adapter.js';
import { recallType } from './kc_shelf.js';

function token(x, max = 48) {
  return typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(x) ? x.slice(0, max) : '';
}

export function startLive(ctx) {
  const queue = [];
  const st = { offline: false, turnOpen: false, turnId: null, startedAt: null, events: 0, last: '', options: [] };

  // A reply's [OPTIONS: …] as the Stage's choice buttons; pressing one sends its text, as
  // KiroCrew's own chips do. Text only (ui.showChoices sets textContent).
  function showOptions() {
    if (!st.options.length) {
      ctx.ui.hideChoices();
      return;
    }
    ctx.ui.showChoices(st.options.map((label, i) => ({ id: `opt-${i}`, label })));
  }

  // 「参照した記憶」の行(名札の右)。textContent だけで組む
  function clearRecall() {
    const old = document.querySelector('#stira-stage-root .kc-recall');
    if (old) old.remove();
  }
  function showRecall(items) {
    clearRecall();
    const box = document.getElementById('textbox');
    if (!box) return;
    const line = document.createElement('div');
    line.className = 'kc-recall';
    const lang = document.getElementById('stira-stage-root')?.lang === 'en' ? 'en' : 'ja';
    const head = lang === 'ja' ? '参照した記憶' : 'Recalled';
    line.textContent = `${head}: ${items.map((i) => `[${recallType(i.type, lang)}] ${i.title}`).join(' · ')}`;
    line.title = line.textContent;
    box.append(line);
    st.recallFresh = true;
    st.lastRecall = items.map((i) => i.title).join(' / ');
  }

  async function onChoice(c) {
    const i = c && typeof c.id === 'string' && c.id.startsWith('opt-') ? Number(c.id.slice(4)) : -1;
    const label = st.options[i];
    if (!label) return;
    const send = globalThis.StiraProgressSend;
    const ok = typeof send === 'function' ? await send(label, null) : false;
    if (ok) return; // the next turn.started clears the buttons
    // cannot send now (a turn runs, an unsettled send): the text waits in the composer
    const input = document.getElementById('stage-input');
    if (input && !input.value) {
      input.value = label;
      input.focus({ preventScroll: true });
    }
  }
  const view = { sayKey: '' };
  const conn = document.getElementById('conn');

  function push(ev, line) {
    queue.push(ev);
    st.events += 1;
    st.last = line;
  }

  function ingestTurnEvent(ev) {
    if (!ev || typeof ev.type !== 'string') return;
    switch (ev.type) {
      case 'turn.started':
        if (!st.recallFresh) clearRecall();
        st.recallFresh = false;
        if (st.options.length) {
          st.options = [];
          ctx.ui.hideChoices();
        }
        st.turnOpen = true;
        st.turnId = token(ev.turn_id) || null;
        st.startedAt = ctx.clock();
        push({ type: 'turn.start', id: st.turnId }, `turn ${st.turnId || '?'} started`);
        break;
      case 'tool.started':
        push({ type: 'tool.start', id: token(ev.id), name: token(ev.name) || 'tool', kind: ['memory', 'web', 'tool'].includes(ev.kind) ? ev.kind : 'tool' }, `tool ${token(ev.name)} (${ev.kind})`);
        break;
      case 'tool.ended':
        push({ type: 'tool.end', id: token(ev.id), ok: ev.ok !== false }, `tool end ${ev.ok === false ? 'failed' : 'ok'}`);
        break;
      case 'turn.ended':
        if (!st.turnOpen) break;
        st.turnOpen = false;
        st.startedAt = null;
        push({ type: 'turn.end', ok: ev.ok !== false }, `turn ${st.turnId || '?'} ${ev.ok === false ? 'error' : 'ok'}`);
        break;
      // 記憶まわりの出来事(ページ自身が起こしたもの)。部屋の小物とキャラが本物の出来事として応える:
      //   recall = 棚を開いた / 章を読んだ → 棚が光り、キャラが棚を見る(kind memory)
      //   look   = 窓から森を見た        → 窓が光る(kind web: 窓 = 外の世界)
      //   write  = 章を書いている間      → 棚が光り続ける(id で始まり、end で終わる)
      //   forget = 章を消した            → 忘れた数が増える(model の memory.forget)
      case 'memory.recall':
      case 'memory.look': {
        const id = `kc-${ev.type}-${Date.now().toString(36)}`;
        const kind = ev.type === 'memory.look' ? 'web' : 'memory';
        push({ type: 'tool.start', id, name: token(ev.name) || (kind === 'web' ? 'forest' : 'shelf'), kind }, `${ev.type} ${token(ev.name)}`);
        setTimeout(() => push({ type: 'tool.end', id, ok: true }, `${ev.type} end`), Math.min(4000, Math.max(600, Number(ev.ms) || 1600)));
        break;
      }
      case 'memory.write':
        if (st.writing === ev.id) break;
        if (st.writing) push({ type: 'tool.end', id: st.writing, ok: true }, 'chapter written');
        st.writing = token(ev.id) || null;
        if (st.writing) push({ type: 'tool.start', id: st.writing, name: 'chapter', kind: 'memory' }, 'chapter writing');
        break;
      case 'memory.write.end':
        if (st.writing) {
          push({ type: 'tool.end', id: st.writing, ok: ev.ok !== false }, 'chapter end');
          push({ type: 'anim', id: 'gesture.ear-perk' }, 'a chapter was written');
        }
        st.writing = null;
        break;
      case 'memory.forget':
        push({ type: 'memory.forget', count: 1 }, 'chapter removed');
        push({ type: 'anim', id: 'gesture.nod' }, 'nod');
        break;
      // この送信に添えた記憶(kc_core recallFor): 棚が光り、テキストウィンドウに「参照した記憶」を出す
      case 'recall.used': {
        const items = Array.isArray(ev.items) ? ev.items.slice(0, 3) : [];
        if (!items.length) break;
        ingestTurnEvent({ type: 'memory.recall', name: 'recall', ms: 2400 });
        showRecall(items);
        ctx.note(`recall ${items.map((i) => i.title).join(' / ')}`);
        break;
      }
      // 他のセッションの作業(kc_watch.js): 動いている間はドローン、承認待ちはアンバーのネオン
      case 'session.busy':
        push({ type: 'tool.start', id: `sess-${token(ev.key)}`, kind: 'subagent', name: String(ev.title || '').slice(0, 40) || 'session' }, `session busy ${token(ev.key)}`);
        break;
      case 'session.idle':
        push({ type: 'tool.end', id: `sess-${token(ev.key)}`, ok: ev.ok !== false }, `session idle ${token(ev.key)}`);
        break;
      case 'session.approval':
        push({ type: 'approval.request', id: `ap-${token(ev.key)}`, summary: String(ev.title || '').slice(0, 60) }, `approval waiting ${token(ev.key)}`);
        break;
      case 'session.summary':
        st.watch = String(ev.text || '').slice(0, 80);
        break;
      case 'session.approval.done':
        push({ type: 'approval.resolved', id: `ap-${token(ev.key)}` }, `approval done ${token(ev.key)}`);
        break;
      case 'options':
        st.options = Array.isArray(ev.items) ? ev.items.filter((s) => typeof s === 'string' && s).slice(0, 6) : [];
        showOptions();
        break;
      case 'offline':
        st.offline = Boolean(ev.value);
        break;
      default:
        break;
    }
  }

  return {
    // the choice window carries a reply's options only (KiroCrew owns tool approvals)
    onChoice,
    tick(now) {
      while (queue.length) ctx.dispatch(queue.shift());
      const S = ctx.strings();
      const generatingSec = st.turnOpen && st.startedAt !== null ? now - st.startedAt : null;
      const say = narrate(ctx.state(), { offline: st.offline, pendingCount: 0, generatingSec });
      const sayKey = `${say.key}|${JSON.stringify(say.vars || {})}|${S.title}`;
      if (sayKey !== view.sayKey && (!ctx.talk || ctx.talk.yieldTo(say.key))) {
        view.sayKey = sayKey;
        ctx.ui.say(S.t(say.key, say.vars));
      }
      if (conn) {
        const state = st.offline ? 'offline' : 'live';
        conn.dataset.state = state;
        conn.textContent = state === 'live' ? S.conn_live : S.conn_offline;
      }
    },
    rawRows() {
      const S = ctx.strings();
      return [
        [S.mode, 'KiroCrew'],
        [S.turn, st.turnId ? `${st.turnId} ${st.turnOpen ? S.turn_open : S.turn_done}` : S.none],
        ['events', `${st.events} · ${st.last || '—'}`],
        ['recall', st.lastRecall || '—'],
        ['sessions', st.watch || '—'],
      ];
    },
    sources: () => [{ url: '/api/chat (stream)', state: st.offline ? 'offline' : 'ok', age: null }],
    gatewayStatus: () => null,
    ingestTurnEvent,
    status: () => ({ offline: st.offline, turnOpen: st.turnOpen, turnId: st.turnId, approval: false, approvalsPending: false }),
    resay() {
      view.sayKey = '';
    },
    relabel() {
      view.sayKey = '';
    },
  };
}
