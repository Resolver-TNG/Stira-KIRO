// Stira-KIRO: 他のセッションの作業を部屋に映す。
//
// GET /api/chat/slots を、Stage が見えている間だけ数秒おきに読み、前回との差を出来事にする:
//   動き始めた   -> session.busy     (部屋にドローンが1機。セッション1つ = 1機、7つ目からは +N)
//   止まった     -> session.idle
//   承認待ち     -> session.approval (アンバーのネオンと「承認待ち」の台詞。承認は KiroCrew 本体で)
//   承認が済んだ -> session.approval.done
// Stage 自身のセッションと、調査用のセッション(stira-probe-…)は数えない。

export const POLL_MS = 4000;

const busyOf = (s) => Boolean(s && (s.running || s.busy || s.streaming || s.subagents_running));
const approvalOf = (s) => Boolean(s && (s.pending_approval || s.pendingApproval));
const keyOf = (s) => (s && (s.key || s.name || s.id)) || '';

// 前回と今回のスロット一覧 -> 出来事の列(純粋。テストする)
export function diffSlots(prev, next, ownKey) {
  const out = [];
  const skip = (k) => !k || k === ownKey || String(k).startsWith('stira-probe') || String(k).startsWith('stira-stage');
  const now = new Map();
  for (const s of next) {
    const k = keyOf(s);
    if (skip(k)) continue;
    now.set(k, { busy: busyOf(s), approval: approvalOf(s), title: String(s.title || s.name || k).slice(0, 60) });
  }
  for (const [k, v] of now) {
    const p = prev.get(k) || { busy: false, approval: false };
    if (v.busy && !p.busy) out.push({ type: 'session.busy', key: k, title: v.title });
    if (!v.busy && p.busy) out.push({ type: 'session.idle', key: k });
    if (v.approval && !p.approval) out.push({ type: 'session.approval', key: k, title: v.title });
    if (!v.approval && p.approval) out.push({ type: 'session.approval.done', key: k });
  }
  for (const [k, p] of prev) {
    if (now.has(k)) continue; // 閉じられたセッション
    if (p.busy) out.push({ type: 'session.idle', key: k });
    if (p.approval) out.push({ type: 'session.approval.done', key: k });
  }
  return { events: out, state: now };
}

export function startWatch({ root, lang, apiFetch, ownKey, emit }) {
  let prev = new Map();
  let timer = null;
  let fails = 0;
  async function tick() {
    timer = null;
    if (!root.isConnected) return; // ページを離れた
    if (document.hidden) {
      timer = setTimeout(tick, POLL_MS * 2);
      return;
    }
    try {
      const r = await apiFetch('/api/chat/slots', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      const list = Array.isArray(body) ? body : Array.isArray(body && body.slots) ? body.slots : [];
      const d = diffSlots(prev, list, ownKey());
      prev = d.state;
      for (const ev of d.events) emit(ev);
      const busy = [...prev.values()].filter((v) => v.busy).length;
      const wait = [...prev.values()].filter((v) => v.approval).length;
      const en = lang === 'en';
      emit({ type: 'session.summary', text: en ? `${prev.size} sessions · working ${busy} · awaiting approval ${wait}` : `${prev.size} 件 · 作業中 ${busy} · 承認待ち ${wait}` });
      fails = 0;
    } catch {
      fails += 1;
    }
    timer = setTimeout(tick, POLL_MS * Math.min(8, 1 + fails));
  }
  timer = setTimeout(tick, 600);
  return { stop: () => timer && clearTimeout(timer) };
}
