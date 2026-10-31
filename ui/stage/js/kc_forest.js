// Stira-KIRO: the forest outside the window. One tree per book of the memory shelf
// (GET /api/apps/stira-kiro/shelf), drawn as pixel art at the Stage's own resolution and scale.
//
// What the picture encodes (nothing is decoration, as in the Stage):
//   tree height   = how many chapters the book has
//   one leaf      = one chapter; its colour = the kind of book
//   leaf brightness = how recent the chapter is (this week bright, older faded)
//   the stars, hills and ground are the night outside the lab's window, fixed by a seed
// Pressing the window zooms out of it into the forest; Esc or "部屋に戻る" goes back.
// A tree opens a panel with its chapters; "ボードで読む" goes back and puts the book on the board.

import { bookName } from './kc_shelf.js';

const KIND = {
  environment: { leaf: [92, 214, 255], dark: [22, 58, 80], ja: '環境メモ', en: 'Environment' },
  journal: { leaf: [255, 196, 92], dark: [78, 52, 22], ja: '作業日誌', en: 'Work log' },
  notes: { leaf: [196, 140, 255], dark: [52, 34, 82], ja: 'ノート', en: 'Notes' },
  project: { leaf: [122, 232, 140], dark: [24, 66, 40], ja: 'プロジェクト', en: 'Project' },
  talk: { leaf: [96, 236, 208], dark: [20, 64, 62], ja: '会話', en: 'Talk' },
};
const DAY = 86400000;

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

// freshness 0..1 from the chapter's date (1 = today, 0 = a month or older)
export function freshness(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.min(1, 1 - (now - t) / (30 * DAY)));
}

// Where each tree stands and how tall it is, in art px. Pure (tested).
export function plantTrees(books, w, h) {
  const n = books.length;
  if (!n) return [];
  const ground = Math.round(h * 0.8);
  const margin = Math.max(18, Math.round(w * 0.06));
  const span = w - margin * 2;
  const maxH = Math.round(h * 0.62);
  const most = Math.max(...books.map((b) => b.chapterCount || 0), 1);
  return books.map((b, i) => {
    const x = Math.round(n === 1 ? w / 2 : margin + (span * i) / (n - 1));
    const share = Math.sqrt((b.chapterCount || 0) / most);
    const height = Math.round(28 + (maxH - 28) * share);
    const crown = Math.round(10 + Math.min(34, 6 + Math.sqrt(b.chapterCount || 1) * 6) * (n > 8 ? 0.7 : 1));
    return { book: b, x, ground, height, crown, top: ground - height };
  });
}

function drawSky(ctx, w, h, seed) {
  const top = [8, 8, 26];
  const low = [34, 24, 62];
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y += 1) {
    const t = y / h;
    for (let x = 0; x < w; x += 1) {
      const k = Math.min(1, t * 1.25);
      const step = Math.floor(k * 6) / 6;
      const c = mix(top, low, bayer(x, y) < (k * 6 - Math.floor(k * 6)) ? step + 1 / 6 : step);
      const o = (y * w + x) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const r = rng(seed);
  for (let i = 0; i < Math.round((w * h) / 900); i += 1) {
    const x = Math.floor(r() * w);
    const y = Math.floor(r() * h * 0.55);
    ctx.fillStyle = rgb([220, 224, 255], 0.35 + r() * 0.6);
    ctx.fillRect(x, y, 1, 1);
  }
  // the moon the lab's window shows
  const mx = Math.round(w * 0.82);
  const my = Math.round(h * 0.16);
  for (let y = -6; y <= 6; y += 1) for (let x = -6; x <= 6; x += 1) {
    const d = x * x + y * y;
    if (d > 36) continue;
    ctx.fillStyle = d > 26 ? rgb([170, 176, 220]) : rgb([226, 228, 250]);
    ctx.fillRect(mx + x, my + y, 1, 1);
  }
}

function drawHills(ctx, w, h, seed) {
  const r = rng(seed ^ 0x9e37);
  for (const [base, amp, col] of [[0.62, 0.07, [26, 22, 52]], [0.7, 0.05, [20, 18, 40]]]) {
    let y = h * base;
    ctx.fillStyle = rgb(col);
    for (let x = 0; x < w; x += 1) {
      y += (r() - 0.5) * 2.2;
      y = Math.max(h * (base - amp), Math.min(h * (base + amp), y));
      ctx.fillRect(x, Math.round(y), 1, h - Math.round(y));
    }
  }
}

function drawGround(ctx, w, h, ground, seed) {
  ctx.fillStyle = rgb([14, 16, 30]);
  ctx.fillRect(0, ground, w, h - ground);
  ctx.fillStyle = rgb([26, 40, 46]);
  ctx.fillRect(0, ground, w, 1);
  const r = rng(seed ^ 0x51ed);
  for (let x = 0; x < w; x += 1) {
    if (r() < 0.35) {
      ctx.fillStyle = rgb([34, 62, 60], 0.9);
      ctx.fillRect(x, ground - 1 - Math.floor(r() * 2), 1, 2);
    }
  }
}

function drawTree(ctx, t, now) {
  const kind = KIND[t.book.kind] || KIND.project;
  const r = rng(hash(t.book.id || t.book.name));
  // trunk: tapered, 1 px highlight on the left
  const base = Math.max(3, Math.round(2 + t.height / 26));
  for (let y = t.ground; y > t.top + t.crown * 0.4; y -= 1) {
    const k = (t.ground - y) / t.height;
    const half = Math.max(1, Math.round((base * (1 - k * 0.6)) / 2));
    const sway = Math.round(Math.sin(k * 3 + (r() - 0.5) * 0.02) * 1);
    ctx.fillStyle = rgb([58, 40, 48]);
    ctx.fillRect(t.x - half + sway, y, half * 2, 1);
    ctx.fillStyle = rgb([92, 66, 70]);
    ctx.fillRect(t.x - half + sway, y, 1, 1);
  }
  // roots
  ctx.fillStyle = rgb([58, 40, 48]);
  ctx.fillRect(t.x - base, t.ground, base * 2, 1);
  ctx.fillRect(t.x - base - 2, t.ground + 1, 3, 1);
  ctx.fillRect(t.x + base - 1, t.ground + 1, 3, 1);
  // crown: dark blobs, then one leaf per chapter
  const cy = t.top + t.crown * 0.55;
  const blobs = 5 + Math.round(t.crown / 6);
  const pts = [];
  for (let i = 0; i < blobs; i += 1) {
    const a = r() * Math.PI * 2;
    const d = r() * t.crown * 0.55;
    pts.push([t.x + Math.cos(a) * d, cy + Math.sin(a) * d * 0.75, t.crown * (0.35 + r() * 0.25)]);
  }
  for (const [bx, by, br] of pts) {
    for (let y = -br; y <= br; y += 1) for (let x = -br; x <= br; x += 1) {
      if (x * x + y * y * 1.3 > br * br) continue;
      const edge = x * x + y * y * 1.3 > br * br * 0.72;
      ctx.fillStyle = rgb(edge ? mix(kind.dark, [10, 10, 20], 0.35) : kind.dark);
      ctx.fillRect(Math.round(bx + x), Math.round(by + y), 1, 1);
    }
  }
  const chapters = (t.book.chapters || []).slice(0, 80);
  chapters.forEach((c) => {
    const [bx, by, br] = pts[Math.floor(r() * pts.length)];
    const a = r() * Math.PI * 2;
    const d = r() * br * 0.85;
    const x = Math.round(bx + Math.cos(a) * d);
    const y = Math.round(by + Math.sin(a) * d * 0.8);
    const f = freshness(c.updatedAt, now);
    const col = mix(mix(kind.dark, kind.leaf, 0.45), kind.leaf, f);
    ctx.fillStyle = rgb(col);
    ctx.fillRect(x, y, 2, 2);
    ctx.fillStyle = rgb(mix(col, [255, 255, 255], 0.35 * f));
    ctx.fillRect(x, y, 1, 1);
    // 要約から生まれた知識の葉: 一回り大きく、芯が光る(1枚 = 再利用できる知識1つ)
    for (const _leaf of (c.leaves || []).slice(0, 3)) {
      const [lx, ly] = [x + Math.round((r() - 0.5) * br), y + Math.round((r() - 0.5) * br * 0.8)];
      ctx.fillStyle = rgb(kind.leaf);
      ctx.fillRect(lx - 1, ly, 3, 1);
      ctx.fillRect(lx, ly - 1, 1, 3);
      ctx.fillStyle = rgb([255, 252, 230]);
      ctx.fillRect(lx, ly, 1, 1);
    }
  });
  // fallen count marker: a book with more chapters than leaves drawn
  return { left: t.x - t.crown, top: t.top - 2, right: t.x + t.crown, bottom: t.ground + 2 };
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function day(iso, lang) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US', { month: 'numeric', day: 'numeric' });
}

export function makeForest({ root, stage, apiFetch, lang, onRead }) {
  const ja = lang === 'ja';
  const box = el('section', 'kc-forest');
  box.hidden = true;
  box.setAttribute('aria-label', ja ? '記憶の森' : 'Forest of memories');
  const canvas = el('canvas', 'kc-forest-view');
  const layer = el('div', 'kc-forest-trees');
  const back = el('button', 'mini kc-forest-back', ja ? '◂ 部屋に戻る' : '◂ Back to the room');
  back.type = 'button';
  const title = el('div', 'kc-forest-title', ja ? '記憶の森' : 'FOREST');
  const legend = el('div', 'kc-forest-legend');
  for (const [k, v] of Object.entries(KIND)) {
    const s = el('span', 'kc-forest-key', ja ? v.ja : v.en);
    s.style.setProperty('--c', rgb(v.leaf));
    legend.append(s);
  }
  const panel = el('aside', 'kc-forest-panel');
  panel.hidden = true;
  // 章の要約(backend/autosum.py): 状態の1行と、手動で回すボタン、自動の切り替え
  const sum = el('div', 'kc-forest-sum');
  const sumText = el('span', 'kc-forest-sum-text', '');
  const sumRun = el('button', 'mini', ja ? '未要約を要約' : 'Summarize');
  sumRun.type = 'button';
  const sumAuto = el('button', 'mini', '');
  sumAuto.type = 'button';
  sum.append(sumText, sumRun, sumAuto);
  box.append(canvas, layer, title, back, legend, sum, panel);
  let sumTimer = null;
  let sumState = null;
  async function refreshSum() {
    try {
      const r = await apiFetch('/api/apps/stira-kiro/chapters/status', { cache: 'no-store' });
      sumState = r.ok ? await r.json() : null;
    } catch {
      sumState = null;
    }
    const s = sumState;
    if (!s) {
      sumText.textContent = ja ? '要約: 状態を読めません' : 'summary: unavailable';
      sumRun.disabled = true;
      sumAuto.hidden = true;
      return;
    }
    const run = s.running ? (ja ? ` · 要約中: ${s.running.title}` : ` · writing: ${s.running.title}`) : '';
    // 章を書いている間、部屋の棚が光り続ける(戻った時に見える)
    if (s.running) emit({ type: 'memory.write', id: `ch-${String(s.running.stem).replace(/[^A-Za-z0-9_.:-]/g, '').slice(-40)}` });
    else emit({ type: 'memory.write.end' });
    sumText.textContent = ja
      ? `未要約 ${s.pending} 章 · 今日 ${s.usedToday}/${s.dailyCap}${run}`
      : `${s.pending} pending · today ${s.usedToday}/${s.dailyCap}${run}`;
    sumRun.disabled = Boolean(s.running) || !s.pending || s.usedToday >= s.dailyCap || !s.spawnAvailable;
    sumAuto.hidden = false;
    sumAuto.textContent = ja ? `自動 ${s.auto ? 'ON' : 'OFF'}` : `auto ${s.auto ? 'on' : 'off'}`;
    sumAuto.setAttribute('aria-pressed', String(s.auto));
    clearTimeout(sumTimer);
    if (!box.hidden) sumTimer = setTimeout(refreshSum, s.running ? 3000 : 15000);
    // 章が書けたら森を描き直す(新しい葉)
    const last = (s.recent || []).filter((x) => x.event === 'written').pop();
    if (last && seenWrite !== null && last.at !== seenWrite) void reload();
    seenWrite = last ? last.at : '';
  }
  let seenWrite = null;
  sumRun.addEventListener('click', async () => {
    sumRun.disabled = true;
    try {
      await apiFetch('/api/apps/stira-kiro/chapters/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 3 }) });
    } catch {
      /* the status line says what happened */
    }
    setTimeout(refreshSum, 800);
  });
  sumAuto.addEventListener('click', async () => {
    if (!sumState) return;
    try {
      await apiFetch('/api/apps/stira-kiro/chapters/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: !sumState.auto }) });
    } catch {
      /* ignore */
    }
    void refreshSum();
  });
  async function reload() {
    try {
      const r = await apiFetch('/api/apps/stira-kiro/shelf', { cache: 'no-store' });
      if (r.ok) data = await r.json();
    } catch {
      /* keep the old picture */
    }
    render();
  }
  stage.append(box);

  let data = null;
  let openAt = null;

  function geometry() {
    const geo = root.stiraLayout;
    const view = stage.querySelector('#view');
    if (!geo || !view) return null;
    return { scale: geo.scale, w: geo.view[0], h: geo.view[1], left: view.offsetLeft, top: view.offsetTop };
  }

  const emit = (ev) => {
    try {
      if (root.stiraLive) root.stiraLive.ingestTurnEvent(ev);
    } catch {
      /* the room just does not react */
    }
  };

  async function confirmed(title, items, okLabel) {
    const c = window.StiraConfirm;
    if (!c || typeof c.open !== 'function') return false;
    return (await c.open({ title, items, confirmLabel: okLabel, cancelLabel: ja ? 'やめる' : 'Cancel' }).catch(() => false)) === true;
  }

  async function reopen(bookId) {
    await reload();
    const b = (data && data.books || []).find((x) => x.id === bookId);
    if (b) showPanel(b);
    else panel.hidden = true;
  }

  // 要約済みの章: 手直し / 書き直し(次の要約で作り直す) / 外す(二度と要約しない)
  function chapterTools(book, c) {
    const row = el('div', 'kc-ch-tools');
    const mk = (label, fn) => {
      const b = el('button', 'mini', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      row.append(b);
    };
    mk(ja ? '手直し' : 'Edit', () => void editChapter(book, c));
    mk(ja ? '書き直し' : 'Redo', async () => {
      if (!(await confirmed(ja ? 'この章を書き直しますか?' : 'Rewrite this chapter?', [c.title, ja ? '今の章は消え、次の要約で材料から作り直します(約1クレジット)。' : 'The chapter is removed and rewritten by the next summary run.'], ja ? '書き直す' : 'Rewrite'))) return;
      await apiFetch(`/api/apps/stira-kiro/chapters/${encodeURIComponent(c.stem)}?mode=redo`, { method: 'DELETE' }).catch(() => null);
      emit({ type: 'memory.forget' });
      await reopen(book.id);
      void refreshSum();
    });
    mk(ja ? '外す' : 'Remove', async () => {
      if (!(await confirmed(ja ? 'この章を記憶から外しますか?' : 'Remove this chapter from memory?', [c.title, ja ? '章と葉が消え、この部分は二度と要約しません。元の会話は消えません。' : 'The chapter and its leaves go; this part is never summarized again. The conversation itself stays.'], ja ? '外す' : 'Remove'))) return;
      await apiFetch(`/api/apps/stira-kiro/chapters/${encodeURIComponent(c.stem)}?mode=skip`, { method: 'DELETE' }).catch(() => null);
      emit({ type: 'memory.forget' });
      await reopen(book.id);
    });
    return row;
  }

  async function editChapter(book, c) {
    let text = '';
    try {
      const r = await apiFetch(`/api/apps/stira-kiro/chapters/${encodeURIComponent(c.stem)}`, { cache: 'no-store' });
      if (r.ok) text = (await r.json()).text || '';
    } catch {
      /* stays empty */
    }
    panel.replaceChildren();
    panel.append(el('h3', null, ja ? `手直し: ${c.title}` : `Edit: ${c.title}`));
    panel.append(el('p', 'kc-forest-meta', ja ? '--- の間の session と part は変えられません。葉は「- [種類] タイトル: 説明」。' : 'session and part cannot change. Leaves: "- [kind] title: text".'));
    const area = el('textarea', 'kc-ch-edit');
    area.value = text;
    area.spellcheck = false;
    const note = el('p', 'kc-ch-note', '');
    note.setAttribute('role', 'status');
    const row = el('div', 'kc-forest-actions');
    const save = el('button', 'mini', ja ? '保存' : 'Save');
    save.type = 'button';
    const cancel = el('button', 'mini', ja ? 'やめる' : 'Cancel');
    cancel.type = 'button';
    save.addEventListener('click', async () => {
      save.disabled = true;
      let msg = '';
      try {
        const r = await apiFetch(`/api/apps/stira-kiro/chapters/${encodeURIComponent(c.stem)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: area.value }) });
        if (r.ok) {
          emit({ type: 'memory.recall', name: 'edit', ms: 1200 });
          await reopen(book.id);
          return;
        }
        msg = ((await r.json().catch(() => ({}))).error) || `HTTP ${r.status}`;
      } catch (err) {
        msg = String(err && err.message);
      }
      note.textContent = (ja ? '保存できません: ' : 'Not saved: ') + msg;
      save.disabled = false;
    });
    cancel.addEventListener('click', () => showPanel(book));
    row.append(save, cancel);
    panel.append(area, note, row);
    panel.hidden = false;
    area.focus({ preventScroll: true });
  }

  function showPanel(book) {
    emit({ type: 'memory.recall', name: 'book', ms: 900 });
    panel.replaceChildren();
    const kind = KIND[book.kind] || KIND.project;
    panel.style.setProperty('--c', rgb(kind.leaf));
    const leafCount = (book.chapters || []).reduce((n, c) => n + ((c.leaves && c.leaves.length) || 0), 0);
    panel.append(el('h3', null, bookName(book, lang)), el('p', 'kc-forest-meta', `${ja ? kind.ja : kind.en} · ${ja ? '章' : 'chapters'} ${book.chapterCount}${leafCount ? ` · ${ja ? '知識の葉' : 'leaves'} ${leafCount}` : ''}`));
    const ul = el('ul');
    for (const c of (book.chapters || []).slice(0, 12)) {
      const li = el('li');
      li.append(el('b', null, `${day(c.updatedAt, lang)} ${c.title}${c.edited ? (ja ? '(手直し済)' : ' (edited)') : ''}`));
      if (c.excerpt && c.excerpt !== c.title) li.append(el('span', null, c.excerpt));
      if (c.written && c.stem) li.append(chapterTools(book, c));
      ul.append(li);
    }
    panel.append(ul);
    const row = el('div', 'kc-forest-actions');
    const read = el('button', 'mini', ja ? 'ボードで読む' : 'Read on the board');
    read.type = 'button';
    read.addEventListener('click', () => {
      close().then(() => onRead && onRead(book));
    });
    const shut = el('button', 'mini', ja ? '閉じる' : 'Close');
    shut.type = 'button';
    shut.addEventListener('click', () => {
      panel.hidden = true;
    });
    row.append(read, shut);
    panel.append(row);
    panel.hidden = false;
  }

  function render() {
    const g = geometry();
    if (!g || !data) return;
    Object.assign(box.style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.w * g.scale}px`, height: `${g.h * g.scale}px` });
    canvas.width = g.w;
    canvas.height = g.h;
    canvas.style.width = `${g.w * g.scale}px`;
    canvas.style.height = `${g.h * g.scale}px`;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const seed = 0x5717a;
    drawSky(ctx, g.w, g.h, seed);
    drawHills(ctx, g.w, g.h, seed);
    const trees = plantTrees(data.books || [], g.w, g.h);
    drawGround(ctx, g.w, g.h, trees.length ? trees[0].ground : Math.round(g.h * 0.8), seed);
    const now = Date.now();
    layer.replaceChildren();
    for (const t of trees) {
      const b = drawTree(ctx, t, now);
      const kind = KIND[t.book.kind] || KIND.project;
      const btn = el('button', 'kc-forest-tree');
      btn.type = 'button';
      btn.style.setProperty('--c', rgb(kind.leaf));
      Object.assign(btn.style, { left: `${b.left * g.scale}px`, top: `${b.top * g.scale}px`, width: `${(b.right - b.left) * g.scale}px`, height: `${(b.bottom - b.top) * g.scale}px` });
      btn.setAttribute('aria-label', `${bookName(t.book, lang)} (${t.book.chapterCount})`);
      const plate = el('span', 'kc-forest-plate', bookName(t.book, lang, true));
      btn.append(plate);
      btn.addEventListener('click', () => showPanel(t.book));
      layer.append(btn);
    }
    if (!trees.length) layer.append(el('p', 'kc-forest-empty', ja ? 'まだ木がありません。' : 'No trees yet.'));
  }

  const onKey = (e) => {
    if (e.key !== 'Escape' || box.hidden) return;
    e.preventDefault();
    e.stopPropagation();
    if (!panel.hidden) panel.hidden = true;
    else void close();
  };

  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function zoom(from, forward) {
    if (reduced() || !box.animate || !from) return Promise.resolve();
    const g = geometry();
    const sx = from.width / (g.w * g.scale);
    const ox = from.left + from.width / 2 - g.left;
    const oy = from.top + from.height / 2 - g.top;
    box.style.transformOrigin = `${ox}px ${oy}px`;
    const frames = [{ transform: `scale(${sx})`, opacity: 0 }, { transform: 'scale(1)', opacity: 1 }];
    return box.animate(forward ? frames : frames.reverse(), { duration: 420, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'none' }).finished.catch(() => {});
  }

  async function open(fromRect) {
    try {
      const r = await apiFetch('/api/apps/stira-kiro/shelf', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      data = await r.json();
    } catch {
      data = { books: [] };
    }
    openAt = fromRect || null;
    panel.hidden = true;
    box.hidden = false;
    root.classList.add('kc-forest-on');
    render();
    document.addEventListener('keydown', onKey, true);
    emit({ type: 'memory.look', name: 'forest', ms: 1400 });
    void refreshSum();
    await zoom(openAt, true);
    back.focus({ preventScroll: true });
  }

  async function close() {
    if (box.hidden) return;
    await zoom(openAt, false);
    box.hidden = true;
    clearTimeout(sumTimer);
    root.classList.remove('kc-forest-on');
    emit({ type: 'memory.look', name: 'forest', ms: 1600 }); // 戻った彼女が窓の外を一度見る
    document.removeEventListener('keydown', onKey, true);
  }

  back.addEventListener('click', () => void close());
  root.addEventListener('stira:layout', () => {
    if (!box.hidden) render();
  });
  return { open, close, get open_() { return !box.hidden; } };
}
