// Stira-KIRO: the memory shelf on the whiteboard. Books (environment notes, the work log,
// notes, projects, conversations) with their newest chapters and a short excerpt each.
// Data: GET /api/apps/stira-kiro/shelf (backend/shelf.py, read-only, redacted). Drawn through
// the board's own Markdown subset, so it is text only, like every reply.

const MAX_CHAPTERS = 6;
const ICON = { environment: '⚙', journal: '✎', notes: '❖', project: '◆', talk: '☰' };

function day(iso, lang) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'ja' ? 'ja-JP' : 'en-US', { month: 'numeric', day: 'numeric' });
}

// The backend names the fixed books in Japanese; English is mapped here by kind.
const FIXED_EN = { environment: 'Environment notes', journal: 'Work journal', notes: 'Notes' };
const STORY_EN = { 状況: 'Situation', 判断: 'Decisions', 結果: 'Outcome', 学び: 'Lessons' };
const LEAF_EN = { 技術: 'tech', 手順: 'how-to', 環境: 'environment', 設計: 'design', 好み: 'preference' };

export function leafKind(kind, lang = 'ja') {
  const k = String(kind || '');
  return lang === 'ja' ? k : LEAF_EN[k] || k;
}

// Display name of a book. `short` drops the "会話: " / "Talk: " prefix (spines are narrow).
export function bookName(book, lang = 'ja', short = false) {
  const raw = String((book && book.name) || '');
  const talk = raw.startsWith('会話: ');
  const base = talk ? raw.slice(4) : raw;
  if (lang === 'ja') return short ? base : raw;
  if (FIXED_EN[book && book.kind]) return FIXED_EN[book.kind];
  return talk && !short ? `Talk: ${base}` : base;
}

// Recall item type from the backend ("章", "葉/技術") in the page's language.
export function recallType(type, lang = 'ja') {
  const t = String(type || '');
  if (lang === 'ja') return t;
  if (t === '章') return 'chapter';
  return t.startsWith('葉/') ? `leaf/${leafKind(t.slice(2), lang)}` : t;
}

// Markdown subset: no raw HTML, and every character the subset treats as markup is escaped
const esc = (s) => String(s ?? '').replace(/[\\`*_[\]#|<>]/g, (c) => `\\${c}`).replace(/\s+/g, ' ').trim();

// 1冊を開いた時: 要約済みの章は 状況→判断→結果→学び と葉まで、新しい順に
export function bookMarkdown(book, lang = 'ja') {
  const ja = lang === 'ja';
  const out = [`# ${ICON[book.kind] || '■'} ${esc(bookName(book, lang))}`];
  out.push(`${ja ? '章' : 'Chapters'} ${book.chapterCount}`);
  for (const c of (book.chapters || []).slice(0, 12)) {
    out.push(`## ${day(c.updatedAt, lang)} ${esc(c.title)}`);
    if (c.story) {
      for (const k of ['状況', '判断', '結果', '学び']) {
        if (c.story[k]) out.push(`**${ja ? k : STORY_EN[k]}**\n${String(c.story[k]).split('\n').map((l) => esc(l.replace(/^[-*]\s*/, ja ? '・' : '- '))).filter(Boolean).join('\n')}`);
      }
      if (Array.isArray(c.leaves) && c.leaves.length) {
        out.push(`**${ja ? '葉(知識)' : 'Leaves'}**\n${c.leaves.map((l) => `- [${esc(leafKind(l.kind, lang))}] **${esc(l.title)}** — ${esc(l.text)}`).join('\n')}`);
      }
    } else if (c.excerpt) {
      out.push(esc(c.excerpt));
    }
  }
  return out.join('\n\n');
}

export function shelfMarkdown(payload, lang = 'ja') {
  const ja = lang === 'ja';
  const books = Array.isArray(payload && payload.books) ? payload.books : [];
  const out = [`# ${ja ? '記憶の棚' : 'Memory shelf'}`];
  if (!books.length) {
    out.push(ja ? 'まだ本がありません。' : 'No books yet.');
    return out.join('\n\n');
  }
  const chapters = books.reduce((n, b) => n + (b.chapterCount || 0), 0);
  out.push(ja ? `本 ${books.length} 冊 · 章 ${chapters}。各本の新しい章から並べています。` : `${books.length} books · ${chapters} chapters, newest first.`);
  for (const b of books) {
    out.push(`## ${ICON[b.kind] || '■'} ${esc(bookName(b, lang))}`);
    const span = `${day(b.startedAt, lang)} – ${day(b.updatedAt, lang)}`;
    out.push(`${ja ? '章' : 'Chapters'} ${b.chapterCount} · ${span}`);
    const rows = (b.chapters || []).slice(0, MAX_CHAPTERS).map((c) => {
      const who = c.agent ? ` (${esc(c.agent)})` : '';
      const more = c.excerpt && c.excerpt !== c.title ? ` — ${esc(c.excerpt)}` : '';
      return `- **${day(c.updatedAt, lang)} ${esc(c.title)}**${who}${more}`;
    });
    const rest = (b.chapters || []).length - MAX_CHAPTERS;
    if (rest > 0) rows.push(ja ? `- …ほか ${rest} 章` : `- … ${rest} more`);
    out.push(rows.join('\n'));
  }
  return out.join('\n\n');
}

// 棚を押した時: 本の背表紙を並べた小さな棚を出し、1冊選ぶとその本だけをボードに下ろす。
// 背表紙の色 = 本の種類(森の葉と同じ色)、厚さ = 章の数。
const SPINE = { environment: '#5cd6ff', journal: '#ffc45c', notes: '#c48cff', project: '#7ae88c', talk: '#60ecd0' };

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function openShelfPicker({ root, apiFetch, classify, lang, onBook }) {
  const ja = lang === 'ja';
  const stage = root.querySelector('#stage');
  const old = stage.querySelector('.kc-shelf');
  if (old) {
    old.remove();
    return Promise.resolve(true);
  }
  const box = el('section', 'kc-shelf');
  box.setAttribute('aria-label', ja ? '記憶の棚' : 'Memory shelf');
  const head = el('div', 'kc-shelf-head');
  head.append(el('span', 'kc-shelf-title', ja ? '記憶の棚' : 'MEMORY'));
  const all = el('button', 'mini', ja ? '目次をボードで' : 'Contents');
  all.type = 'button';
  const shut = el('button', 'mini', '×');
  shut.type = 'button';
  shut.setAttribute('aria-label', ja ? '閉じる' : 'Close');
  head.append(all, shut);
  const rows = el('div', 'kc-shelf-rows');
  const hint = el('p', 'kc-shelf-hint', ja ? '読み込み中…' : 'Loading…');
  box.append(head, rows, hint);
  const anchor = stage.querySelector('.kc-hotspot[data-spot="shelf"]');
  if (anchor) {
    box.style.left = `${anchor.offsetLeft + anchor.offsetWidth + 8}px`;
    box.style.top = `${Math.max(8, anchor.offsetTop)}px`;
  }
  stage.append(box);
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  shut.addEventListener('click', close);
  let payload = null;
  const board = root.stiraBoard;
  const show = (text, key) => {
    if (board) board.show({ key, text, c: classify(text) }, { explicit: true });
  };
  all.addEventListener('click', () => {
    if (payload) show(shelfMarkdown(payload, lang), `shelf-${Date.now()}`);
    close();
  });
  return (async () => {
    try {
      const r = await apiFetch('/api/apps/stira-kiro/shelf', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      payload = await r.json();
    } catch (err) {
      const msg = String(err && err.message);
      // 404 = 入っているアプリにバックエンドが無い(UI だけ新しい)。直し方を言う
      hint.textContent = msg === '404'
        ? (ja ? '棚のバックエンドが入っていません。ライブラリで Stira Stage の「同期」を押してください。' : 'The shelf backend is not installed. Sync Stira Stage in the Library.')
        : (ja ? '棚を読めませんでした: ' : 'Could not read the shelf: ') + msg;
      return true;
    }
    const books = payload.books || [];
    hint.textContent = ja ? `${books.length} 冊 · 背表紙を選ぶとボードで開きます` : `${books.length} books · pick one to read it`;
    const most = Math.max(1, ...books.map((b) => b.chapterCount || 0));
    // 種類ごとに1段
    const kinds = [...new Set(books.map((b) => b.kind))];
    for (const k of kinds) {
      const row = el('div', 'kc-shelf-row');
      for (const b of books.filter((x) => x.kind === k)) {
        const spine = el('button', 'kc-spine');
        spine.type = 'button';
        spine.style.setProperty('--c', SPINE[b.kind] || '#9a98c0');
        spine.style.setProperty('--w', `${Math.round(18 + 26 * Math.sqrt((b.chapterCount || 0) / most))}px`);
        spine.append(el('span', 'kc-spine-name', bookName(b, lang, true)));
        spine.append(el('span', 'kc-spine-n', String(b.chapterCount || 0)));
        spine.title = ja ? `${bookName(b, lang)}(章 ${b.chapterCount})` : `${bookName(b, lang)} (chapters ${b.chapterCount})`;
        spine.setAttribute('aria-label', spine.title);
        spine.addEventListener('click', () => {
          if (onBook) onBook(b);
          show(bookMarkdown(b, lang), `book-${b.id}-${Date.now()}`);
          close();
        });
        row.append(spine);
      }
      rows.append(row);
    }
    const first = rows.querySelector('.kc-spine');
    if (first) first.focus({ preventScroll: true });
    return true;
  })();
}

export async function openShelf({ root, apiFetch, classify, lang }) {
  const board = root.stiraBoard;
  if (!board) return false;
  let text;
  try {
    const r = await apiFetch('/api/apps/stira-kiro/shelf', { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    text = shelfMarkdown(await r.json(), lang);
  } catch (err) {
    text = `# ${lang === 'ja' ? '記憶の棚' : 'Memory shelf'}\n\n${lang === 'ja' ? '棚を読めませんでした' : 'Could not read the shelf'} (${esc(err && err.message)}).`;
  }
  board.show({ key: `shelf-${Date.now()}`, text, c: classify(text) }, { explicit: true });
  return true;
}
