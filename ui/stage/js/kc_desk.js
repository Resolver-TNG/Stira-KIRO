// Stira-KIRO: local Git repositories on the workbench. DOM is built only with
// createElement/textContent; details use the board's safe Markdown subset.

export const DESK_POLL_MS = 5 * 60 * 1000;
export const GRADE_POLL_MS = 1000;

const VIEW_TOP_ROW = 10;
// ../kc-assets/desk-notes.png (tools/make_desk_notes.py): cells of NOTE_WORLD_SIZE px,
// column = kind * NOTE_TILTS + tilt, row = status. The tilt is drawn into the pixels
// (stepped edges), so the page never rotates a note smoothly.
export const NOTE_WORLD_SIZE = 24;
export const NOTE_KINDS = ['note', 'tape', 'pin'];
export const NOTE_TILTS = 3;
const NOTE_ROW = { red: 0, yellow: 1, green: 2 };
const NOTE_ATLAS_SIZE = [NOTE_WORLD_SIZE * NOTE_KINDS.length * NOTE_TILTS, NOTE_WORLD_SIZE * 3];
const NOTE_IMAGE_URL = new URL('../kc-assets/desk-notes.png', import.meta.url).href;

export function noteSprite(note) {
  const kind = Math.max(0, NOTE_KINDS.indexOf(note.kind));
  const tilt = Math.min(NOTE_TILTS - 1, Math.max(0, Number(note.tilt) || 0));
  return { x: (kind * NOTE_TILTS + tilt) * NOTE_WORLD_SIZE, y: (NOTE_ROW[note.status] ?? 0) * NOTE_WORLD_SIZE };
}

// Room-image coordinates (assets/bg is 640x340). The grid capture at 1180x670,
// Stage scale=2 measured the usable wall as x=528..615: right of the curtain,
// left of the cropped edge, below/above the wall clock, and clear of both hotspot tags.
// A 22px note fits every slot. The 19-20px pitch gives a slight overlap, and
// the large clock gap between the first two rows is deliberate.
export const NOTE_SLOTS = [
  [531, 31], [550, 31], [569, 31], [588, 31],
  [531, 91], [550, 91], [569, 91], [588, 91],
  [531, 111], [550, 111], [569, 111], [588, 111],
];

const NOTE_FALLBACK = { red: '#924a48', yellow: '#9a824e', green: '#688062' }; // atlas mid tones
const viewLeft = (vw) => Math.round(320 - vw / 2);

function hashId(value) {
  let hash = 2166136261;
  for (const char of String(value ?? '')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function repositoryStatus(repo) {
  if (repo && repo.error) return 'red';
  return repo && ['red', 'yellow', 'green'].includes(repo.status) ? repo.status : 'red';
}

export function noteLayout(repositories, slots = NOTE_SLOTS) {
  const repos = Array.isArray(repositories) ? repositories : [];
  const free = slots.map((_, index) => index);
  const notes = [];
  const sorted = [...repos].sort((a, b) => hashId(a && a.id) - hashId(b && b.id));
  for (const repo of sorted) {
    if (!free.length) break;
    const hash = hashId(repo && repo.id);
    const slot = free.splice(hash % free.length, 1)[0];
    const [x, y] = slots[slot];
    notes.push({
      repo,
      status: repositoryStatus(repo),
      slot,
      // 枠からのずれを大きめに取り、格子に見えないようにする (整数ドット)
      x: x + ((hash >>> 8) % 9) - 4,
      y: y + ((hash >>> 12) % 9) - 4,
      kind: NOTE_KINDS[(hash >>> 16) % NOTE_KINDS.length],
      tilt: (hash >>> 20) % NOTE_TILTS,
    });
  }
  // Equal z-index uses DOM paint order, so red notes are appended last and sit on top.
  notes.sort((a, b) => Number(a.status === 'red') - Number(b.status === 'red'));
  return { notes, rest: Math.max(0, repos.length - slots.length) };
}

export function newlyRedRepositoryIds(previous, next) {
  if (!previous) return [];
  const before = new Map(repositoriesOf(previous).map((repo) => [repo.id, repositoryStatus(repo)]));
  return repositoriesOf(next)
    .filter((repo) => before.has(repo.id) && before.get(repo.id) !== 'red' && repositoryStatus(repo) === 'red')
    .map((repo) => repo.id);
}

export function gradeFilter(grade) {
  if (!grade || typeof grade !== 'object') return '';
  const dim = Math.min(1, Math.max(0, Number(grade.dim) || 0));
  const desat = Math.min(1, Math.max(0, Number(grade.desat) || 0));
  const ambient = Array.isArray(grade.ambient) && grade.ambient.length >= 3
    ? grade.ambient.slice(0, 3).map((value) => Math.min(2, Math.max(0, Number(value) || 0)))
    : [1, 1, 1];
  const brightness = (ambient[0] + ambient[1] + ambient[2]) / 3 * (1 - dim);
  return `brightness(${Math.round(brightness * 100)}%) saturate(${Math.round((1 - desat) * 100)}%)`;
}

// The board's Markdown subset (markdown.js) has no backslash escapes: a `\` stays visible and
// `\*x\*` still turns into emphasis. The only span it keeps literal is inline code, so every
// value from Git (names, paths, branches, subjects, errors) goes inside one. A backtick in the
// value would close the span early, so it is swapped for a look-alike (U+02B9).
// Our own sentences (to-do lines): only whitespace is folded.
const plain = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const esc = (s) => {
  const text = String(s ?? '').replace(/\s+/g, ' ').trim().replace(/`/g, '\u02b9');
  return text ? `\`${text}\`` : '';
};

function day(iso, lang) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function statusLabel(status, lang) {
  const labels = lang === 'ja'
    ? { red: '要確認', yellow: '作業中', green: '正常' }
    : { red: 'Attention', yellow: 'In progress', green: 'Clean' };
  return labels[status] || (lang === 'ja' ? '不明' : 'Unknown');
}

function branchName(repo) {
  return String((repo && repo.branch) || '(detached)');
}

function repositoriesOf(payload) {
  return Array.isArray(payload && payload.repositories) ? payload.repositories : [];
}

export function normalizeDeskPath(value) {
  let text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
  return text;
}

export function uniqueDeskPaths(values) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeDeskPath(value);
    if (!normalized) continue;
    const key = normalized.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

const CONFIG_REASON_JA = new Map([
  ['path is empty', 'パスが空です'],
  ['network paths are not allowed because checking them may block', 'ネットワークパスは検査が長時間停止することがあるため使えません'],
  ['path must be absolute', '絶対パスを指定してください'],
  ['path does not exist', 'パスが見つかりません'],
  ['path is not a directory', 'ディレクトリではありません'],
  ['symbolic links and junctions are not allowed', 'シンボリックリンクとジャンクションは使えません'],
  ['path is not a Git repository (.git not found)', 'Git リポジトリではありません (.git が見つかりません)'],
]);

export function deskConfigProblemMap(problems, lang = 'en') {
  const mapped = new Map();
  for (const problem of Array.isArray(problems) ? problems : []) {
    if (!problem || !['paths', 'scanRoots'].includes(problem.field) || !Number.isInteger(problem.index)) continue;
    const reason = String(problem.reason || '');
    mapped.set(`${problem.field}:${problem.index}`, lang === 'ja' ? (CONFIG_REASON_JA.get(reason) || reason) : reason);
  }
  return mapped;
}

export function deskEmptyState(config, payload) {
  if (repositoriesOf(payload).length) return null;
  const paths = Array.isArray(config && config.paths) ? config.paths : [];
  const roots = Array.isArray(config && config.scanRoots) ? config.scanRoots : [];
  return paths.length || roots.length ? 'not-found' : 'unconfigured';
}

export function repositoryGroups(payload) {
  const groups = new Map();
  for (const repo of repositoriesOf(payload)) {
    const key = String(repo && repo.group ? repo.group : `single:${repo && repo.id ? repo.id : groups.size}`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(repo);
  }
  return [...groups.entries()].map(([key, repositories]) => ({ key, repositories }));
}

function statusCounts(repositories) {
  const counts = { red: 0, yellow: 0, green: 0 };
  for (const repo of repositories) counts[repositoryStatus(repo)] += 1;
  return counts;
}

function localBranchNodes(repo) {
  if (repo.branches === null) {
    return [{
      id: `branches-unavailable:${repo.id}`,
      type: 'message',
      label: 'branches-unavailable',
      status: 'red',
      children: [],
    }];
  }
  const branches = Array.isArray(repo.branches) ? [...repo.branches] : [];
  branches.sort((a, b) => {
    const rank = (branch) => branch.name === repo.branch ? 0 : branch.name === repo.defaultBranch ? 1 : 2;
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name), 'en');
  });
  return branches.map((branch) => ({
    id: `branch:${repo.id}:${branch.name}`,
    type: 'branch',
    label: String(branch.name || ''),
    current: branch.name === repo.branch,
    ahead: Number(branch.ahead) || 0,
    behind: Number(branch.behind) || 0,
    status: Number(branch.behind) > 0 ? 'red' : 'green',
    children: [],
  }));
}

function worktreeNodes(repo) {
  const worktrees = Array.isArray(repo.worktreeList) ? repo.worktreeList : [];
  return worktrees.filter((worktree) => !worktree.main).map((worktree, index) => ({
    id: `worktree:${repo.id}:${index}:${worktree.path || ''}`,
    type: 'worktree',
    label: String(worktree.path || ''),
    branch: worktree.branch ? String(worktree.branch) : null,
    head: String(worktree.head || '').slice(0, 7),
    detached: Boolean(worktree.detached),
    prunable: Boolean(worktree.prunable),
    locked: Boolean(worktree.locked),
    status: worktree.prunable ? 'red' : 'green',
    children: [],
  }));
}

function repositoryNode(repo) {
  const status = repositoryStatus(repo);
  return {
    id: `repo:${repo.id}`,
    type: 'repository',
    label: String(repo.name || ''),
    status,
    defaultExpanded: status === 'red',
    repo,
    children: [...localBranchNodes(repo), ...worktreeNodes(repo)],
  };
}

function remoteLabel(repositories) {
  const repo = repositories[0] || {};
  return String(repo.github || repo.originUrl || '');
}

export function buildRepositoryTree(payload, lang = 'ja') {
  const folders = new Map();
  for (const repo of repositoriesOf(payload)) {
    const root = repo.root == null ? null : String(repo.root);
    const key = root == null ? 'listed' : `root:${root}`;
    if (!folders.has(key)) folders.set(key, { key, root, repositories: [] });
    folders.get(key).repositories.push(repo);
  }

  const ordered = [...folders.values()].sort((a, b) => {
    if (a.root == null) return b.root == null ? 0 : 1;
    if (b.root == null) return -1;
    return a.root.localeCompare(b.root, 'en');
  });

  return ordered.map((folder) => {
    const grouped = new Map();
    for (const repo of folder.repositories) {
      const key = String(repo.group || `single:${repo.id}`);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(repo);
    }
    const emitted = new Set();
    const children = [];
    for (const repo of folder.repositories) {
      const key = String(repo.group || `single:${repo.id}`);
      if (emitted.has(key)) continue;
      emitted.add(key);
      const clones = grouped.get(key) || [repo];
      const label = remoteLabel(clones);
      if (clones.length >= 2 && label) {
        children.push({
          id: `remote:${folder.key}:${key}`,
          type: 'remote',
          label,
          count: clones.length,
          defaultExpanded: true,
          children: clones.map(repositoryNode),
        });
      } else {
        children.push(...clones.map(repositoryNode));
      }
    }
    return {
      id: `folder:${folder.key}`,
      type: 'folder',
      label: folder.root || (lang === 'ja' ? '個別指定' : 'Listed'),
      fullLabel: folder.root || (lang === 'ja' ? '個別指定' : 'Listed'),
      counts: statusCounts(folder.repositories),
      defaultExpanded: true,
      children,
    };
  });
}

export function worstStatus(payload) {
  let worst = 'green';
  for (const repo of repositoriesOf(payload)) {
    if (repo && repo.status === 'red') return 'red';
    if (repo && repo.status === 'yellow') worst = 'yellow';
  }
  return worst;
}

const SEVERITY_RANK = { red: 0, yellow: 1, info: 2, green: 3 };

function countWorktrees(repo, key) {
  const list = Array.isArray(repo && repo.worktreeList) ? repo.worktreeList : [];
  const fromList = list.filter((worktree) => Boolean(worktree && worktree[key])).length;
  if (fromList || key !== 'prunable') return fromList;
  return Number(repo && repo.worktrees && repo.worktrees.prunable) || 0;
}

function errorHead(error) {
  return String(error ?? '').split(/\r?\n/, 1)[0].trim();
}

export function deskIssues(repo, allRepositories = [], lang = 'ja') {
  if (!repo || typeof repo !== 'object') return [];
  const ja = lang === 'ja';
  const issues = [];
  const add = (severity, text) => issues.push({ severity, text });
  const branch = repo.branch ? String(repo.branch) : null;
  const defaultBranch = String(repo.defaultBranch || 'main');
  const upstream = repo.upstream ? String(repo.upstream) : null;
  const compareBase = repo.compareBase ? String(repo.compareBase) : defaultBranch;
  const behind = Number(repo.behind) || 0;
  const ahead = Number(repo.ahead) || 0;

  if (repo.error) add('red', ja ? `取得エラー: ${errorHead(repo.error)}` : `Read error: ${errorHead(repo.error)}`);
  let upstreamText = null;
  if (behind > 0 && upstream) {
    upstreamText = ja
      ? `${branch || 'detached HEAD'} が ${upstream} より ${behind} 遅れ`
      : `${branch || 'detached HEAD'} is ${behind} behind ${upstream}`;
    add('red', upstreamText);
  }
  const defaultEntry = Array.isArray(repo.branches)
    ? repo.branches.find((candidate) => String(candidate && candidate.name) === defaultBranch)
    : null;
  const defaultBehind = Number(defaultEntry && defaultEntry.behind) || 0;
  if (defaultBehind > 0) {
    const text = ja
      ? `${defaultBranch} が ${compareBase} より ${defaultBehind} 遅れ`
      : `${defaultBranch} is ${defaultBehind} behind ${compareBase}`;
    if (text !== upstreamText) add('red', text);
  }
  const prunable = countWorktrees(repo, 'prunable');
  if (prunable > 0) add('red', ja ? `消えた worktree の残骸 ${prunable}` : `Stale worktrees ${prunable}`);

  const changes = Number(repo.changes && repo.changes.total) || 0;
  if (changes > 0) add('yellow', ja ? `未コミット ${changes}` : `Uncommitted changes ${changes}`);
  if (ahead > 0) add('yellow', ja ? `未 push ${ahead}` : `Unpushed commits ${ahead}`);
  if (!branch) add('yellow', 'detached HEAD');
  else if (branch !== defaultBranch) add('yellow', ja ? `${branch} に居る` : `On ${branch}`);
  const stash = Number(repo.stashCount) || 0;
  if (stash > 0) add('yellow', `stash ${stash}`);

  const peers = (Array.isArray(allRepositories) ? allRepositories : [])
    .filter((candidate) => candidate && candidate.id !== repo.id && repo.group && candidate.group === repo.group)
    .map((candidate) => String(candidate.name || candidate.id || ''))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, lang === 'ja' ? 'ja' : 'en'));
  if (peers.length) add('info', `${ja ? '同じ remote' : 'Same remote'}: ${peers.join(', ')}`);
  const locked = countWorktrees(repo, 'locked');
  if (locked > 0) add('info', `locked worktree ${locked}`);
  return issues;
}

function rowSeverity(repo, issues) {
  const status = repositoryStatus(repo);
  if (status === 'red') return 'red';
  if (issues.some((issue) => issue.severity === 'red')) return 'red';
  if (status === 'yellow') return 'yellow';
  if (issues.some((issue) => issue.severity === 'yellow')) return 'yellow';
  if (issues.some((issue) => issue.severity === 'info')) return 'info';
  return 'green';
}

export function deskRepositoryRows(payload, lang = 'ja') {
  const repositories = repositoriesOf(payload);
  const rows = repositories.map((repo) => {
    const issues = deskIssues(repo, repositories, lang);
    return { repo, issues, severity: rowSeverity(repo, issues) };
  });
  const actionable = rows.filter((row) => row.severity !== 'green').sort((a, b) => {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      || b.issues.length - a.issues.length
      || String(a.repo.name || '').localeCompare(String(b.repo.name || ''), lang === 'ja' ? 'ja' : 'en');
  });
  const clean = rows.filter((row) => row.severity === 'green').sort((a, b) => (
    String(a.repo.name || '').localeCompare(String(b.repo.name || ''), lang === 'ja' ? 'ja' : 'en')
  ));
  return { actionable, clean };
}

export function repoMarkdown(repo, lang = 'ja', allRepositories = []) {
  const ja = lang === 'ja';
  const out = [`# ${esc(repo && repo.name)}`];
  out.push(`**${ja ? '状態' : 'Status'}**: ${statusLabel(repositoryStatus(repo), lang)}`);
  const issues = deskIssues(repo, allRepositories, lang);
  out.push(`## ${ja ? 'やること' : 'To do'}\n${issues.length ? issues.map((issue) => `- ${plain(issue.text)}`).join('\n') : (ja ? 'なし' : 'None')}`);
  if (repo && repo.error) {
    out.push(`**${ja ? '取得エラー' : 'Read error'}**: ${esc(repo.error)}`);
    if (repo.path) out.push(`**${ja ? '場所' : 'Path'}**: ${esc(repo.path)}`);
    return out.join('\n\n');
  }
  const changes = repo.changes || {};
  const worktrees = repo.worktrees || {};
  const src = repo.defaultBranchSource === 'origin/HEAD' ? ' (origin/HEAD)' : repo.defaultBranchSource === 'fallback' ? (ja ? ' (推定)' : ' (guessed)') : '';
  out.push(`**${ja ? 'ブランチ' : 'Branch'}**: ${esc(branchName(repo))} · ${ja ? '既定' : 'default'} ${esc(repo.defaultBranch || 'main')}${src}`);
  out.push(`**upstream**: ${repo.upstream ? esc(repo.upstream) : (ja ? 'なし' : 'none')} · ahead ${Number(repo.ahead) || 0} · behind ${Number(repo.behind) || 0}`);
  out.push(`**${ja ? '変更' : 'Changes'}**: staged ${Number(changes.staged) || 0} · unstaged ${Number(changes.unstaged) || 0} · untracked ${Number(changes.untracked) || 0}`);
  out.push(`**worktree**: ${Number(worktrees.total) || 0} · prunable ${Number(worktrees.prunable) || 0} · stash ${Number(repo.stashCount) || 0}`);
  if (repo.github || repo.originUrl) {
    out.push(`**remote**: ${esc(repo.github || repo.originUrl)}${repo.github && repo.originUrl ? ` · ${esc(repo.originUrl)}` : ''}`);
  } else {
    out.push(`**remote**: ${ja ? 'なし' : 'none'}`);
  }
  if (repo.lastCommit) {
    out.push(`**${ja ? '最終コミット' : 'Last commit'}**: ${esc(repo.lastCommit.hash)} · ${day(repo.lastCommit.date, lang)}\n${esc(repo.lastCommit.subject)}`);
  }
  out.push(`**${ja ? '最終 fetch' : 'Last fetch'}**: ${repo.fetchHeadUpdatedAt ? day(repo.fetchHeadUpdatedAt, lang) : (ja ? '記録なし' : 'no record')}`);
  if (Array.isArray(repo.branches)) {
    const rows = repo.branches.map((b) => `- ${esc(b.name)} · ahead ${Number(b.ahead) || 0} · behind ${Number(b.behind) || 0}`);
    const vs = repo.compareBase ? (ja ? `(${esc(repo.compareBase)} との差)` : `(vs ${esc(repo.compareBase)})`) : '';
    out.push(`## ${ja ? 'ローカルブランチ' : 'Local branches'} ${vs}\n${rows.length ? rows.join('\n') : (ja ? 'なし' : 'None')}`);
  } else {
    out.push(`## ${ja ? 'ローカルブランチ' : 'Local branches'}\n${ja ? 'この Git では差分を取得できません。' : 'Branch differences are unavailable with this Git version.'}`);
  }
  if (repo.path) out.push(`**${ja ? '場所' : 'Path'}**: ${esc(repo.path)}`);
  return out.join('\n\n');
}

// The board renders one list level only (markdown.js), so the map is flattened: a heading per
// folder, a bold line per shared remote, one bullet per repository and one bullet per branch /
// worktree under it, drawn as a branch with box-drawing characters.
function childLine(node, lang, last) {
  const ja = lang === 'ja';
  const lead = last ? '└' : '├';
  if (node.type === 'branch') {
    const counts = [node.ahead ? `↑${node.ahead}` : '', node.behind ? `↓${node.behind}` : ''].filter(Boolean).join(' ');
    return `- ${lead} ${node.current ? '* ' : ''}${esc(node.label)}${counts ? ` · ${counts}` : ''}`;
  }
  if (node.type === 'worktree') {
    const identity = node.branch || `detached ${node.head}`.trim();
    const flags = [node.locked ? 'locked' : '', node.prunable ? (ja ? '**prunable (残骸)**' : '**prunable**') : ''].filter(Boolean);
    return `- ${lead} ⎇ ${esc(node.label)} · ${esc(identity)}${flags.length ? ` · ${flags.join(' · ')}` : ''}`;
  }
  return `- ${lead} ${ja ? 'ブランチ差分を取得できません' : 'Branch differences unavailable'}`;
}

function repositoryBlock(node, lang) {
  const mark = node.status === 'red' ? '**!** ' : '';
  const lines = [`- ${mark}${node.label ? esc(node.label) : '?'} · ${statusLabel(node.status, lang)}`];
  const kids = node.children || [];
  kids.forEach((child, index) => lines.push(childLine(child, lang, index === kids.length - 1)));
  return lines.join('\n');
}

function appendSection(out, node, lang) {
  if (node.type === 'folder') {
    out.push(`## ${esc(node.label)}`);
    const repos = [];
    const flush = () => { if (repos.length) out.push(repos.splice(0).join('\n')); };
    for (const child of node.children || []) {
      if (child.type === 'remote') {
        flush();
        out.push(`**${lang === 'ja' ? '同じ remote' : 'Same remote'}**: ${esc(child.label)}`);
        out.push((child.children || []).map((repo) => repositoryBlock(repo, lang)).join('\n'));
      } else {
        repos.push(repositoryBlock(child, lang));
      }
    }
    flush();
  } else if (node.type === 'repository') {
    out.push(repositoryBlock(node, lang));
  }
}

export function deskMarkdown(payload, lang = 'ja') {
  const ja = lang === 'ja';
  const repositories = repositoriesOf(payload);
  const out = [`# ${ja ? '作業机' : 'WORKBENCH'}`];
  if (!repositories.length) {
    out.push(ja ? 'リポジトリはまだ登録されていません。' : 'No repositories are configured yet.');
    return out.join('\n\n');
  }
  out.push(ja ? `ローカルリポジトリ ${repositories.length} 件。Git の読み取り時点の全体図です。` : `${repositories.length} local repositories. This is the latest local Git map.`);
  for (const node of buildRepositoryTree(payload, lang)) appendSection(out, node, lang);
  return out.join('\n\n');
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function replaceRepository(payload, repository) {
  const list = repositoriesOf(payload);
  const next = list.map((repo) => (repo.id === repository.id ? { ...repo, ...repository } : repo));
  if (!next.some((repo) => repo.id === repository.id)) next.push(repository);
  return { ...(payload || {}), repositories: next };
}

export function startDeskStatus({ root, stage, apiFetch, classify = null, lang = 'ja', onRepo = null }) {
  const notesRoot = el('div', 'kc-desk-notes');
  notesRoot.setAttribute('aria-label', lang === 'ja' ? 'リポジトリの付箋' : 'Repository notes');
  stage.append(notesRoot);
  let payload = null;
  let noteImageReady = false;
  let timer = null;
  let gradeTimer = null;
  let stopped = false;
  let inFlight = null;

  const pick = (repo) => {
    if (onRepo) onRepo(repo);
    if (!root.stiraBoard || typeof classify !== 'function') return;
    const text = repoMarkdown(repo, lang, repositoriesOf(payload));
    root.stiraBoard.show({ key: `repo-${repo.id}-${Date.now()}`, text, c: classify(text) }, { explicit: true });
  };

  const place = (geo) => {
    if (!geo) return;
    const canvas = stage.querySelector('#view');
    const off = canvas ? { x: canvas.offsetLeft, y: canvas.offsetTop } : { x: 0, y: 0 };
    const leftEdge = viewLeft(geo.view[0]);
    const viewWidth = geo.view[0] * geo.scale;
    const viewHeight = geo.view[1] * geo.scale;
    for (const button of notesRoot.querySelectorAll('.kc-desk-note')) {
      const x = Number(button.dataset.x);
      const y = Number(button.dataset.y);
      const left = (x - leftEdge) * geo.scale;
      const top = (y - VIEW_TOP_ROW) * geo.scale;
      const size = NOTE_WORLD_SIZE * geo.scale;
      button.hidden = left + size < 0 || top + size < 0 || left > viewWidth || top > viewHeight;
      Object.assign(button.style, {
        left: `${off.x + left}px`,
        top: `${off.y + top}px`,
        width: `${size}px`,
        height: `${size}px`,
        backgroundSize: `${NOTE_ATLAS_SIZE[0] * geo.scale}px ${NOTE_ATLAS_SIZE[1] * geo.scale}px`,
        backgroundPosition: `${-Number(button.dataset.spriteX) * geo.scale}px ${-Number(button.dataset.spriteY) * geo.scale}px`,
      });
    }
    const more = notesRoot.querySelector('.kc-desk-note-more');
    if (more) {
      const left = (570 - leftEdge) * geo.scale;
      const top = (140 - VIEW_TOP_ROW) * geo.scale;
      more.hidden = left < 0 || top < 0 || left > viewWidth || top > viewHeight;
      Object.assign(more.style, { left: `${off.x + left}px`, top: `${off.y + top}px` });
    }
  };

  const render = (animateIds = []) => {
    notesRoot.replaceChildren();
    const animated = new Set(animateIds);
    const { notes, rest } = noteLayout(repositoriesOf(payload));
    for (const note of notes) {
      const button = el('button', 'kc-desk-note');
      button.type = 'button';
      button.dataset.x = String(note.x);
      button.dataset.y = String(note.y);
      button.dataset.status = note.status;
      button.dataset.repoId = String(note.repo.id ?? '');
      const sprite = noteSprite(note);
      button.dataset.spriteX = String(sprite.x);
      button.dataset.spriteY = String(sprite.y);
      button.dataset.kind = note.kind;
      button.title = `${note.repo.name || note.repo.id} (${statusLabel(note.status, lang)})`;
      button.setAttribute('aria-label', button.title);
      if (!noteImageReady) button.style.backgroundColor = NOTE_FALLBACK[note.status];
      if (noteImageReady) button.style.backgroundImage = `url(${NOTE_IMAGE_URL})`;
      if (animated.has(note.repo.id)) button.classList.add('kc-desk-note-restick');
      button.addEventListener('click', () => pick(note.repo));
      notesRoot.append(button);
    }
    if (rest) {
      const more = el('span', 'kc-desk-note-more', `+${rest}`);
      more.setAttribute('aria-label', lang === 'ja' ? `ほか ${rest} 件` : `${rest} more repositories`);
      notesRoot.append(more);
    }
    notesRoot.hidden = notes.length === 0;
    place(root.stiraLayout);
  };

  const apply = (next) => {
    const animate = newlyRedRepositoryIds(payload, next);
    payload = next;
    render(animate);
    return payload;
  };

  const refresh = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const response = await apiFetch('/api/apps/stira-kiro/repos', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      return apply(await response.json());
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  const schedule = () => {
    if (stopped || document.hidden || !root.isConnected) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try { await refresh(); } catch { /* the current notes remain until the next poll */ }
      schedule();
    }, DESK_POLL_MS);
  };

  const updateGrade = () => {
    if (document.hidden || stage.querySelector('.board:not([hidden])')) return;
    const grade = typeof root.stiraGrade === 'function' ? root.stiraGrade() : null;
    const filter = gradeFilter(grade);
    if (filter) notesRoot.style.filter = filter;
    else notesRoot.style.removeProperty('filter');
  };

  const visible = () => {
    clearTimeout(timer);
    timer = null;
    if (!document.hidden && !stopped && root.isConnected) {
      updateGrade();
      void refresh().catch(() => {}).finally(schedule);
    }
  };
  const layout = (event) => place(event.detail);
  document.addEventListener('visibilitychange', visible);
  root.addEventListener('stira:layout', layout);
  gradeTimer = setInterval(updateGrade, GRADE_POLL_MS);

  const noteImages = (async () => {
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', reject, { once: true });
        image.src = NOTE_IMAGE_URL;
      });
      noteImageReady = true;
      render();
    } catch {
      noteImageReady = false;
    }
  })();
  const ready = Promise.all([
    noteImages,
    document.hidden ? Promise.resolve(null) : refresh().catch(() => null),
  ]).finally(() => {
    updateGrade();
    schedule();
  });

  return {
    ready,
    refresh,
    getPayload: () => payload,
    setPayload: apply,
    updateRepository: (repository) => apply(replaceRepository(payload, repository)),
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(gradeTimer);
      document.removeEventListener('visibilitychange', visible);
      root.removeEventListener('stira:layout', layout);
      notesRoot.remove();
    },
  };
}

let cleanRepositoriesExpanded = false;

export function openDeskPicker({ root, apiFetch, classify, lang, onRepo, deskStatus = null, initialView = 'list' }) {
  const ja = lang === 'ja';
  const stage = root.querySelector('#stage');
  if (!stage) return Promise.resolve(false);
  const old = stage.querySelector('.kc-desk');
  if (old) {
    old.remove();
    return Promise.resolve(true);
  }
  const box = el('section', 'kc-desk');
  box.setAttribute('aria-label', ja ? '作業机' : 'Work bench');
  const head = el('div', 'kc-desk-head');
  head.append(el('span', 'kc-desk-title', ja ? '作業机' : 'WORKBENCH'));
  const folderSettings = el('button', 'mini kc-desk-folders', ja ? 'フォルダ' : 'Folders');
  folderSettings.type = 'button';
  folderSettings.setAttribute('aria-label', ja ? '見るフォルダを設定' : 'Configure watched folders');
  const all = el('button', 'mini', ja ? '一覧をボードで' : 'Overview');
  all.type = 'button';
  all.setAttribute('aria-label', ja ? 'リポジトリ一覧をボードで開く' : 'Open repository overview on the board');
  const shut = el('button', 'mini', '×');
  shut.type = 'button';
  shut.setAttribute('aria-label', ja ? '閉じる' : 'Close');
  head.append(folderSettings, all, shut);
  const rows = el('div', 'kc-desk-rows');
  rows.setAttribute('role', 'list');
  rows.setAttribute('aria-label', ja ? 'リポジトリのやることリスト' : 'Repository to-do list');
  const hint = el('p', 'kc-desk-hint', ja ? '読み込み中…' : 'Loading…');
  box.append(head, rows, hint);
  stage.append(box);
  const anchor = stage.querySelector('.kc-hotspot[data-spot="desk"]');
  const margin = 8;
  const left = anchor
    ? Math.max(margin, Math.min(anchor.offsetLeft, stage.clientWidth - box.offsetWidth - margin))
    : margin;
  box.style.left = `${left}px`;
  box.style.top = `${margin}px`;
  box.style.maxHeight = `${Math.max(172, stage.clientHeight - margin * 2)}px`;
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', onEscape, true);
  };
  const onEscape = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener('keydown', onEscape, true);
  shut.addEventListener('click', close);
  let payload = null;
  let config = { paths: [], scanRoots: [], scanDepth: 1 };
  let draft = { paths: [], scanRoots: [], scanDepth: 1 };
  let view = initialView === 'settings' ? 'settings' : 'list';
  let configProblems = new Map();
  let configError = '';
  let saving = false;
  let activeId = null;
  const rowErrors = new Map();
  const show = (text, key) => {
    if (root.stiraBoard) root.stiraBoard.show({ key, text, c: classify(text) }, { explicit: true });
  };
  all.addEventListener('click', () => {
    if (payload) show(deskMarkdown(payload, lang), `desk-${Date.now()}`);
    close();
  });

  const choose = (repo) => {
    if (onRepo) onRepo(repo);
    show(repoMarkdown(repo, lang, repositoriesOf(payload)), `repo-${repo.id}-${Date.now()}`);
    close();
  };

  const appendFetch = (line, repo) => {
    const fetchButton = el('button', 'mini kc-desk-fetch', 'fetch');
    fetchButton.type = 'button';
    fetchButton.disabled = !repo.id;
    fetchButton.setAttribute('aria-label', ja ? `${repo.name || ''} を fetch` : `Fetch ${repo.name || ''}`);
    fetchButton.addEventListener('click', async (event) => {
      event.stopPropagation();
      fetchButton.disabled = true;
      fetchButton.textContent = ja ? '取得中...' : 'Fetching...';
      rowErrors.delete(repo.id);
      try {
        const response = await apiFetch(`/api/apps/stira-kiro/repos/${encodeURIComponent(repo.id)}/fetch`, { method: 'POST', cache: 'no-store' });
        let body = {};
        try { body = await response.json(); } catch { /* status text is enough */ }
        const updated = response.ok ? body : body.repository;
        if (updated && updated.id) {
          payload = replaceRepository(payload, updated);
          if (deskStatus) deskStatus.setPayload(payload);
        }
        if (!response.ok) throw new Error(body.error || String(response.status));
      } catch (err) {
        rowErrors.set(repo.id, String((err && err.message) || err).slice(0, 120));
      }
      renderRows(String(repo.id || ''));
    });
    line.append(fetchButton);
  };

  const repositoryItem = (row, clean = false) => {
    const repo = row.repo;
    const item = el('div', 'kc-desk-item');
    item.setAttribute('role', 'listitem');
    item.dataset.status = row.severity;
    const action = el('button', 'kc-desk-row-action');
    action.type = 'button';
    action.tabIndex = -1;
    action.dataset.rowId = String(repo.id || '');
    const marker = el('span', 'kc-desk-row-mark', clean ? '' : row.severity === 'red' ? '!' : row.severity === 'yellow' ? '·' : '');
    marker.setAttribute('aria-hidden', 'true');
    const name = el('span', 'kc-desk-name', repo.name || (ja ? '名前なし' : 'Unnamed'));
    name.title = String(repo.name || '');
    action.append(marker, name);
    if (!clean) {
      const issueText = row.issues.map((issue) => issue.text).join(' / ')
        || (ja ? '状態を確認' : 'Check status');
      const issue = el('span', 'kc-desk-issue', issueText);
      issue.title = issueText;
      action.append(issue);
      action.setAttribute('aria-label', `${repo.name || ''}: ${issueText}`);
    } else {
      action.classList.add('kc-desk-row-clean');
      action.setAttribute('aria-label', String(repo.name || ''));
    }
    action.addEventListener('click', () => choose(repo));
    item.append(action);
    appendFetch(item, repo);
    if (rowErrors.has(repo.id)) item.append(el('p', 'kc-desk-fetch-error', rowErrors.get(repo.id)));
    return item;
  };

  const cleanSummaryItem = (count) => {
    const item = el('div', 'kc-desk-item kc-desk-clean-summary');
    item.setAttribute('role', 'listitem');
    const action = el('button', 'kc-desk-row-action');
    action.type = 'button';
    action.tabIndex = -1;
    action.dataset.rowId = 'clean-toggle';
    action.setAttribute('aria-expanded', String(cleanRepositoriesExpanded));
    action.append(
      el('span', 'kc-desk-row-mark', ''),
      el('span', 'kc-desk-clean-label', ja ? `問題なし ${count} 件 ${cleanRepositoriesExpanded ? '▾' : '▸'}` : `No issues ${count} ${cleanRepositoriesExpanded ? '▾' : '▸'}`),
    );
    action.addEventListener('click', () => {
      cleanRepositoriesExpanded = !cleanRepositoriesExpanded;
      renderRows('clean-toggle');
    });
    item.append(action);
    return item;
  };

  const showSettings = (reset = true) => {
    if (reset) {
      draft = {
        paths: uniqueDeskPaths(config.paths),
        scanRoots: uniqueDeskPaths(config.scanRoots),
        scanDepth: 1,
      };
      configProblems = new Map();
      configError = '';
    }
    view = 'settings';
    renderSettings();
  };
  folderSettings.addEventListener('click', () => showSettings(true));

  const addDraftPath = (field, input) => {
    const value = normalizeDeskPath(input.value);
    if (!value) return;
    draft[field] = uniqueDeskPaths([...(draft[field] || []), value]);
    configProblems = new Map();
    configError = '';
    renderSettings();
    const next = rows.querySelector(`[data-input-field="${field}"]`);
    if (next) next.focus();
  };

  const configField = (field, title) => {
    const section = el('section', 'kc-desk-config-section');
    section.append(el('h3', 'kc-desk-config-title', title));
    const list = el('div', 'kc-desk-config-list');
    list.setAttribute('aria-label', title);
    (draft[field] || []).forEach((path, index) => {
      const line = el('div', 'kc-desk-config-row');
      const value = el('span', 'kc-desk-config-path', path);
      value.title = path;
      const remove = el('button', 'mini kc-desk-config-remove', 'x');
      remove.type = 'button';
      remove.setAttribute('aria-label', ja ? `${path} を削除` : `Remove ${path}`);
      remove.addEventListener('click', () => {
        draft[field] = draft[field].filter((_item, itemIndex) => itemIndex !== index);
        configProblems = new Map();
        configError = '';
        renderSettings();
      });
      line.append(value, remove);
      const reason = configProblems.get(`${field}:${index}`);
      if (reason) line.append(el('p', 'kc-desk-config-error', reason));
      list.append(line);
    });
    if (!(draft[field] || []).length) {
      list.append(el('p', 'kc-desk-config-none', ja ? 'まだありません' : 'None yet'));
    }
    const add = el('div', 'kc-desk-config-add');
    const input = el('input', 'kc-desk-config-input');
    input.type = 'text';
    input.dataset.inputField = field;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', ja ? `${title}を追加` : `Add ${title}`);
    input.placeholder = field === 'scanRoots'
      ? (ja ? '例: C:\\example\\projects' : 'e.g. C:\\example\\projects')
      : (ja ? '例: C:\\example\\project' : 'e.g. C:\\example\\project');
    const addButton = el('button', 'mini', ja ? '追加' : 'Add');
    addButton.type = 'button';
    addButton.setAttribute('aria-label', ja ? `${title}を追加` : `Add ${title}`);
    addButton.addEventListener('click', () => addDraftPath(field, input));
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addDraftPath(field, input);
    });
    add.append(input, addButton);
    section.append(list, add);
    return section;
  };

  async function saveSettings(saveButton) {
    if (saving) return;
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = ja ? '保存中...' : 'Saving...';
    configProblems = new Map();
    configError = '';
    try {
      const submitted = {
        paths: uniqueDeskPaths(draft.paths),
        scanRoots: uniqueDeskPaths(draft.scanRoots),
        scanDepth: 1,
      };
      const response = await apiFetch('/api/apps/stira-kiro/repos/config', {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitted),
      });
      let body = {};
      try { body = await response.json(); } catch { /* status text is enough */ }
      if (!response.ok) {
        configProblems = deskConfigProblemMap(body.problems, lang);
        configError = configProblems.size ? '' : (body.error || String(response.status));
        renderSettings();
        return;
      }
      config = body.config || submitted;
      draft = { paths: [...config.paths], scanRoots: [...config.scanRoots], scanDepth: 1 };
      if (deskStatus) payload = await deskStatus.refresh();
      else {
        const reposResponse = await apiFetch('/api/apps/stira-kiro/repos', { cache: 'no-store' });
        if (!reposResponse.ok) throw new Error(String(reposResponse.status));
        payload = await reposResponse.json();
      }
      view = 'list';
      renderRows();
    } catch (err) {
      configError = (ja ? '保存後の読み直しに失敗しました: ' : 'Could not refresh after saving: ')
        + String((err && err.message) || err);
      renderSettings();
    } finally {
      saving = false;
    }
  }

  function renderSettings() {
    rows.replaceChildren();
    rows.classList.add('kc-desk-settings');
    rows.removeAttribute('role');
    rows.setAttribute('aria-label', ja ? '見るフォルダの設定' : 'Watched folder settings');
    folderSettings.setAttribute('aria-expanded', 'true');
    folderSettings.classList.remove('kc-desk-folders-attention');
    all.hidden = true;
    if (deskEmptyState(config, payload) === 'unconfigured') {
      rows.append(el('p', 'kc-desk-empty', ja
        ? 'まだ見るフォルダがありません。ここで追加すると作業机が使えます。'
        : 'There are no watched folders yet. Add one here to start using the workbench.'));
    }
    rows.append(
      configField('scanRoots', ja ? '探すフォルダ' : 'Folders to scan'),
      configField('paths', ja ? '個別に指定したリポジトリ' : 'Individually listed repositories'),
    );
    if (configError) rows.append(el('p', 'kc-desk-config-message', configError));
    const actions = el('div', 'kc-desk-config-actions');
    const cancel = el('button', 'mini', ja ? 'やめる' : 'Cancel');
    cancel.type = 'button';
    cancel.setAttribute('aria-label', ja ? '変更を保存せずやめる' : 'Cancel without saving');
    cancel.addEventListener('click', () => {
      view = 'list';
      configProblems = new Map();
      configError = '';
      renderRows();
    });
    const save = el('button', 'mini kc-desk-config-save', ja ? '保存' : 'Save');
    save.type = 'button';
    save.setAttribute('aria-label', ja ? 'フォルダ設定を保存' : 'Save folder settings');
    save.addEventListener('click', () => { void saveSettings(save); });
    actions.append(save, cancel);
    rows.append(actions);
    hint.textContent = ja
      ? '絶対パスだけ保存できます。ネットワークパス、リンク、ジャンクションは使えません。'
      : 'Only absolute local paths are allowed. Network paths, links, and junctions are rejected.';
  }

  function renderRows(focusId = activeId) {
    view = 'list';
    rows.replaceChildren();
    rows.classList.remove('kc-desk-settings');
    rows.setAttribute('role', 'list');
    rows.setAttribute('aria-label', ja ? 'リポジトリのやることリスト' : 'Repository to-do list');
    folderSettings.setAttribute('aria-expanded', 'false');
    all.hidden = false;
    const empty = deskEmptyState(config, payload);
    folderSettings.classList.toggle('kc-desk-folders-attention', empty === 'not-found');
    if (empty) {
      rows.append(el('p', 'kc-desk-empty', empty === 'unconfigured'
        ? (ja ? 'まだ見るフォルダがありません' : 'There are no watched folders yet')
        : (ja ? '設定したフォルダにリポジトリが見つかりません' : 'No repositories were found in the configured folders')));
    }
    const listing = deskRepositoryRows(payload, lang);
    for (const row of listing.actionable) rows.append(repositoryItem(row));
    if (listing.clean.length) {
      rows.append(cleanSummaryItem(listing.clean.length));
      if (cleanRepositoriesExpanded) {
        for (const row of listing.clean) rows.append(repositoryItem(row, true));
      }
    }
    const actions = [...rows.querySelectorAll('.kc-desk-row-action')];
    const selected = actions.find((action) => action.dataset.rowId === focusId) || actions[0];
    for (const action of actions) action.tabIndex = action === selected ? 0 : -1;
    activeId = selected ? selected.dataset.rowId : null;
    if (focusId && selected) selected.focus({ preventScroll: true });
    hint.textContent = empty === 'unconfigured'
      ? (ja ? '「フォルダ」から見る場所を追加してください' : 'Use Folders to add locations to watch')
      : empty === 'not-found'
        ? (ja ? '「フォルダ」で設定を見直してください' : 'Review the configuration under Folders')
        : ja
          ? `${listing.actionable.length} 件に手が要る · 行を選ぶとボードで開きます`
          : `${listing.actionable.length} need attention · select a row to open it on the board`;
  }

  rows.addEventListener('focusin', (event) => {
    const action = event.target.closest && event.target.closest('.kc-desk-row-action');
    if (!action || !rows.contains(action)) return;
    for (const other of rows.querySelectorAll('.kc-desk-row-action')) other.tabIndex = other === action ? 0 : -1;
    activeId = action.dataset.rowId;
  });

  rows.addEventListener('keydown', (event) => {
    if (event.target.closest && event.target.closest('.kc-desk-fetch')) return;
    const action = event.target.closest && event.target.closest('.kc-desk-row-action');
    if (!action) return;
    const visible = [...rows.querySelectorAll('.kc-desk-row-action')];
    const index = visible.indexOf(action);
    let target = null;
    if (event.key === 'ArrowDown') target = visible[Math.min(visible.length - 1, index + 1)];
    else if (event.key === 'ArrowUp') target = visible[Math.max(0, index - 1)];
    else return;
    event.preventDefault();
    if (target) target.focus({ preventScroll: false });
  });

  return (async () => {
    try {
      const configResponse = await apiFetch('/api/apps/stira-kiro/repos/config', { cache: 'no-store' });
      if (!configResponse.ok) throw new Error(String(configResponse.status));
      config = await configResponse.json();
      config = {
        paths: uniqueDeskPaths(config.paths),
        scanRoots: uniqueDeskPaths(config.scanRoots),
        scanDepth: 1,
      };
      payload = deskStatus && deskStatus.getPayload();
      if (!payload) {
        if (deskStatus) payload = await deskStatus.refresh();
        else {
          const response = await apiFetch('/api/apps/stira-kiro/repos', { cache: 'no-store' });
          if (!response.ok) throw new Error(String(response.status));
          payload = await response.json();
        }
      }
    } catch (err) {
      const message = String(err && err.message);
      hint.textContent = message === '404'
        ? (ja ? '作業机のバックエンドが入っていません。ライブラリで Stira Stage の「同期」を押してください。' : 'The workbench backend is not installed. Sync Stira Stage in the Library.')
        : (ja ? '作業机を読めませんでした: ' : 'Could not read the workbench: ') + message;
      return true;
    }
    if (view === 'settings' || deskEmptyState(config, payload) === 'unconfigured') {
      showSettings(true);
    } else {
      renderRows();
      const first = rows.querySelector('.kc-desk-row-action');
      if (first) first.focus({ preventScroll: true });
    }
    return true;
  })();
}
