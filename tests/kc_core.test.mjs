// node --test tests/  — kc_core against a fake KiroCrew /api/chat stream.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };

const base = {
  payloadOf: (message) => JSON.stringify({ message }),
  commandOf: (m) => (/^\/new\s*$/.test(m || '') ? 'new' : null),
  newKey: () => 'k1',
};
const { makeCore } = await import('../ui/stage/js/kc_core.js');

function sse(frames) {
  const body = frames.map((f) => (f === 'DONE' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(f)}\n\n`)).join(': keepalive\n\n');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function fakeFetch(chatFrames) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/api/chat/slots') return new Response('{}', { status: 200 });
    if (url === '/api/chat') return sse(chatFrames);
    return new Response('{}', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}

test('streams chunks, maps tools, ends the turn', async () => {
  const fetch = fakeFetch([
    { type: 'user', content: 'hi' },
    { type: 'tool', content: 'web_fetch https://example.com' },
    { type: 'chunk', content: 'Hel' },
    { type: 'chunk', content: 'lo' },
    { type: 'assistant', content: 'Hello' },
    'DONE',
  ]);
  const core = makeCore(base, { fetch });
  const sender = core.createSender({ fetch, t: (k) => k });
  const deltas = [];
  const ui = [];
  let turn = null;
  const r = await sender.send({ message: 'hi' }, { delta: (d) => deltas.push(d.text), uiEvent: (e) => ui.push(e), turn: (d) => (turn = d) });
  assert.equal(r.ok, true);
  assert.equal(deltas.join(''), 'Hello');
  assert.deepEqual(ui.map((e) => e.type), ['turn.started', 'tool.started', 'tool.ended', 'turn.ended']);
  assert.equal(ui[1].kind, 'web');
  assert.equal(ui[1].name, 'web_fetch');
  assert.ok(turn && turn.turn_id);
  const sent = JSON.parse(fetch.calls.find((c) => c.url === '/api/chat').init.body);
  assert.equal(sent.message, 'hi');
  assert.match(sent.slot, /^stira-stage-/);
  assert.equal(sender.unsettled, null);
});

test('a reply that arrives only as its final row is delivered once', async () => {
  const fetch = fakeFetch([{ type: 'assistant', content: 'PROBE-OK' }, 'DONE']);
  const core = makeCore(base, { fetch });
  const deltas = [];
  const r = await core.createSender({ fetch }).send({ message: 'x' }, { delta: (d) => deltas.push(d.text) });
  assert.equal(r.ok, true);
  assert.deepEqual(deltas, ['PROBE-OK']);
});

test('a stream cut before [DONE] stays unsettled', async () => {
  const fetch = fakeFetch([{ type: 'chunk', content: 'par' }]);
  const core = makeCore(base, { fetch });
  const sender = core.createSender({ fetch });
  const r = await sender.send({ message: 'y' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.delivery, 'unknown');
  assert.ok(sender.unsettled);
});

test('/new is never sent', async () => {
  const fetch = fakeFetch(['DONE']);
  const r = await makeCore(base, { fetch }).createSender({ fetch }).send({ message: '/new' }, {});
  assert.equal(r.command, 'new');
  assert.equal(fetch.calls.length, 0);
});

test('history pairs user rows with the replies after them', async () => {
  store.set('stira.kiro.slot', 'stira-stage-test');
  const fetch = async () => new Response(JSON.stringify({ messages: [
    { role: 'user', content: 'q1', meta: { mid: 'm1' } },
    { role: 'tool', content: 'x' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
  ] }), { status: 200 });
  const { turns } = await makeCore(base, { fetch }).fetchConversation();
  assert.deepEqual(turns, [
    { turn_id: 'm1', message: 'q1', response: 'a1' },
    { turn_id: 'u-1', message: 'q2', response: '' },
  ]);
});


test('text before a tool call is reset; the reply is what follows the last tool', async () => {
  const fetch = fakeFetch([
    { type: 'chunk', content: 'まず調べます。' },
    { type: 'tool', content: 'read_file x' },
    { type: 'chunk', content: '出しました。' },
    { type: 'assistant', content: 'まず調べます。出しました。' },
    'DONE',
  ]);
  const core = makeCore(base, { fetch });
  let reply = '';
  const r = await core.createSender({ fetch }).send({ message: 'z' }, {
    delta: (d) => (reply += d.text),
    uiEvent: (e) => { if (e.type === 'segment.reset') reply = ''; },
  });
  assert.equal(r.ok, true);
  assert.equal(reply, '出しました。');
});

test('mcwidget becomes a fenced block the board can draw', async () => {
  const { toWidgetFences } = await import('../ui/stage/js/kc_widget.js');
  const { parse, classify } = await import('../ui/stage/js/markdown.js');
  const text = 'はい。\n<mcwidget title="T"><div style="color:red">hi</div></mcwidget>\n以上';
  assert.match(toWidgetFences(text), /````mcwidget\n<div style="color:red">hi<\/div>\n````/);
  const blocks = parse(text);
  const code = blocks.find((b) => b.t === 'code');
  assert.equal(code.lang, 'mcwidget');
  assert.equal(code.closed, true);
  assert.equal(classify(text).mode, 'board');
});


test('[OPTIONS] becomes buttons and leaves the text', async () => {
  const { extractOptions, prepareReply } = await import('../ui/stage/js/kc_widget.js');
  const text = '描けました。\n\n[OPTIONS: 色を赤に | 登山用で描き直して]';
  assert.deepEqual(extractOptions(text), ['色を赤に', '登山用で描き直して']);
  assert.equal(prepareReply(text), '描けました。');
  const fetch = fakeFetch([{ type: 'chunk', content: text }, 'DONE']);
  const ui = [];
  const r = await makeCore(base, { fetch }).createSender({ fetch }).send({ message: 'o' }, { uiEvent: (e) => ui.push(e) });
  assert.equal(r.ok, true);
  const opt = ui.find((e) => e.type === 'options');
  assert.deepEqual(opt.items, ['色を赤に', '登山用で描き直して']);
});

test('the Stage hint goes to the new session once', async () => {
  store.delete('stira.kiro.slot');
  const fetch = fakeFetch(['DONE']);
  const core = makeCore(base, { fetch });
  const sender = core.createSender({ fetch });
  await sender.send({ message: 'a' }, {});
  await sender.send({ message: 'b' }, {});
  const hints = fetch.calls.filter((c) => /\/context$/.test(c.url));
  assert.equal(hints.length, 1);
  assert.match(JSON.parse(hints[0].init.body).content, /Stira Stage/);
});

test('hotspot rects map image coords to the view', async () => {
  const { spotRect } = await import('../ui/stage/js/kc_hotspots.js');
  // view 433 wide: left = round(320 - 216.5) = 104 (Math.round(103.5) = 104)
  assert.deepEqual(spotRect([104, 44, 104, 178], { scale: 3, view: [433, 286] }), { left: 0, top: 102, width: 312, height: 534 });
});


test('the shelf is a board: a heading per book, chapters as a list, markup escaped', async () => {
  const { shelfMarkdown } = await import('../ui/stage/js/kc_shelf.js');
  const { classify } = await import('../ui/stage/js/markdown.js');
  const md = shelfMarkdown({ books: [{ kind: 'project', name: 'workspace', chapterCount: 2, startedAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z',
    chapters: [{ title: 'Stira *forest* <b>x</b>', agent: 'kirocrew', updatedAt: '2026-10-31T00:00:00Z' }, { title: 'two', agent: '', updatedAt: '2026-10-30T00:00:00Z' }] }] }, 'ja');
  assert.match(md, /^# 記憶の棚/);
  assert.match(md, /## ◆ workspace/);
  assert.match(md, /Stira \\\*forest\\\* \\<b\\>x\\<\/b\\>/);
  assert.equal(classify(md).mode, 'board');
});


test('forest: one tree per book, taller with more chapters, inside the view', async () => {
  const { plantTrees, freshness } = await import('../ui/stage/js/kc_forest.js');
  const books = [{ id: 'a', chapterCount: 1 }, { id: 'b', chapterCount: 25 }, { id: 'c', chapterCount: 6 }];
  const trees = plantTrees(books, 450, 330);
  assert.equal(trees.length, 3);
  assert.ok(trees[1].height > trees[2].height && trees[2].height > trees[0].height);
  for (const t of trees) {
    assert.ok(t.x > 0 && t.x < 450);
    assert.ok(t.top - t.crown > 0, 'the crown stays below the top edge');
  }
  const now = Date.parse('2026-10-31T00:00:00Z');
  assert.equal(freshness('2026-10-31T00:00:00Z', now), 1);
  assert.equal(freshness('2026-09-01T00:00:00Z', now), 0);
});


test('other sessions: busy / idle / approval transitions, own and probe sessions ignored', async () => {
  const { diffSlots } = await import('../ui/stage/js/kc_watch.js');
  const a = diffSlots(new Map(), [{ key: 'chat-1', title: 'Tarkov', running: true }, { key: 'own', running: true }, { key: 'stira-probe-x', running: true }], 'own');
  assert.deepEqual(a.events, [{ type: 'session.busy', key: 'chat-1', title: 'Tarkov' }]);
  const b = diffSlots(a.state, [{ key: 'chat-1', title: 'Tarkov', running: true, pending_approval: true }], 'own');
  assert.deepEqual(b.events.map((e) => e.type), ['session.approval']);
  const c = diffSlots(b.state, [], 'own');
  assert.deepEqual(c.events.map((e) => e.type), ['session.idle', 'session.approval.done']);
});

test('a busy session becomes a drone in the room model', async () => {
  const { initialState, reduce, derive } = await import('../ui/stage/js/model.js');
  let s = initialState();
  s = reduce(s, { type: 'tool.start', id: 'sess-chat-1', kind: 'subagent', name: 'Tarkov' });
  assert.equal(s.agents.length, 1);
  assert.equal(s.agents[0].status, 'run');
  derive(s);
  s = reduce(s, { type: 'tool.end', id: 'sess-chat-1', ok: true });
  assert.notEqual(s.agents[0] && s.agents[0].status, 'run');
});

test('recall: the hits ride along with the send as silent context', async () => {
  store.delete('stira.kiro.slot');
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/memory/brief')) return new Response(JSON.stringify({ text: '[Stira 記憶の目次] x' }), { status: 200 });
    if (url.endsWith('/memory/relevant')) return new Response(JSON.stringify({ hits: [{ type: '葉/手順', title: 'ui ロック', chapter: 'c__01' }], context: '[Stira 記憶] ui ロック' }), { status: 200 });
    if (url === '/api/chat/slots') return new Response('{}', { status: 200 });
    if (url === '/api/chat') return sse([{ type: 'chunk', content: 'ok' }, 'DONE']);
    return new Response('{}', { status: 200 });
  };
  const ui = [];
  const r = await makeCore(base, { fetch }).createSender({ fetch }).send({ message: 'ui がロックされた' }, { uiEvent: (e) => ui.push(e) });
  assert.equal(r.ok, true);
  const ctxCalls = calls.filter((c) => /\/context$/.test(c.url)).map((c) => JSON.parse(c.init.body));
  assert.deepEqual(ctxCalls.map((c) => c.source), ['stira-stage', 'stira-recall']);
  assert.match(ctxCalls[0].content, /記憶の目次/);
  const used = ui.find((e) => e.type === 'recall.used');
  assert.equal(used.items[0].title, 'ui ロック');
  // the recall context goes before the chat send
  assert.ok(calls.findIndex((c) => c.url === '/api/chat') > calls.findIndex((c) => /\/context$/.test(c.url) && JSON.parse(c.init.body).source === 'stira-recall'));
});


test('book names and recall types follow the page language', async () => {
  const { bookName, recallType, bookMarkdown } = await import('../ui/stage/js/kc_shelf.js');
  const talk = { kind: 'talk', name: '会話: Stira-KIRO' };
  assert.equal(bookName(talk, 'ja'), '会話: Stira-KIRO');
  assert.equal(bookName(talk, 'ja', true), 'Stira-KIRO');
  assert.equal(bookName(talk, 'en'), 'Talk: Stira-KIRO');
  assert.equal(bookName({ kind: 'journal', name: '作業日誌' }, 'en'), 'Work journal');
  assert.equal(bookName({ kind: 'project', name: 'my-repo' }, 'en'), 'my-repo');
  assert.equal(recallType('章', 'en'), 'chapter');
  assert.equal(recallType('葉/手順', 'en'), 'leaf/how-to');
  assert.equal(recallType('葉/手順', 'ja'), '葉/手順');
  const md = bookMarkdown({ kind: 'talk', name: '会話: x', chapterCount: 1, chapters: [{ title: 't', story: { 結果: 'done' }, leaves: [{ kind: '技術', title: 'a', text: 'b' }] }] }, 'en');
  assert.match(md, /\*\*Outcome\*\*/);
  assert.match(md, /\[tech\]/);
  assert.doesNotMatch(md, /結果|技術/);
});
