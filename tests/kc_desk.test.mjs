import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  deskConfigProblemMap,
  deskDashboardRecord,
  deskDashboardSendDecision,
  deskEmptyState,
  deskIssues,
  deskMarkdown,
  deskRepositoryRows,
  gradeFilter,
  newlyRedRepositoryIds,
  normalizeDeskPath,
  noteLayout,
  noteSprite,
  NOTE_KINDS,
  NOTE_TILTS,
  NOTE_WORLD_SIZE,
  repoMarkdown,
  repositoryStatus,
  uniqueDeskPaths,
  worstStatus,
} from '../ui/stage/js/kc_desk.js';
import { SPOTS } from '../ui/stage/js/kc_hotspots.js';
import { parse as parseBoard } from '../ui/stage/js/markdown.js';

const repo = {
  id: 'local-1',
  name: 'Stira *desk* <x>',
  path: 'X:\\repos\\Stira_[desk]',
  root: 'X:\\repos',
  group: 'repo-a',
  status: 'red',
  branch: 'feat/[desk]',
  defaultBranch: 'main',
  upstream: 'origin/feat/desk',
  compareBase: 'origin/main',
  ahead: 2,
  behind: 3,
  changes: { staged: 1, unstaged: 2, untracked: 3, total: 6 },
  branches: [
    { name: 'feat/[desk]', ahead: 2, behind: 3 },
    { name: 'main', ahead: 0, behind: 5 },
  ],
  worktrees: { total: 2, prunable: 1 },
  worktreeList: [
    { path: 'X:\\repos\\Stira_[desk]', branch: 'feat/[desk]', main: true },
    { path: 'X:\\gone', branch: null, prunable: true, locked: true, main: false },
  ],
  stashCount: 4,
  lastCommit: { hash: 'abc1234', date: '2026-11-06T00:00:00Z', subject: 'fix `desk` <script>' },
  originUrl: 'https://github.com/Resolver-TNG/Stira-KIRO.git',
  github: 'Resolver-TNG/Stira-KIRO',
  fetchHeadUpdatedAt: '2026-11-05T00:00:00Z',
};

const cleanRepo = (overrides = {}) => ({
  id: 'clean',
  name: 'clean',
  group: null,
  status: 'green',
  branch: 'main',
  defaultBranch: 'main',
  upstream: 'origin/main',
  compareBase: 'origin/main',
  ahead: 0,
  behind: 0,
  changes: { total: 0 },
  branches: [{ name: 'main', ahead: 0, behind: 0 }],
  worktrees: { total: 1, prunable: 0 },
  worktreeList: [{ path: 'X:\\clean', branch: 'main', main: true, locked: false, prunable: false }],
  stashCount: 0,
  ...overrides,
});

test('deskIssues returns red issues in priority order and does not duplicate the current default branch lag', () => {
  const item = cleanRepo({
    error: 'git failed\nsecond line',
    status: 'red',
    behind: 3,
    branches: [{ name: 'main', ahead: 0, behind: 3 }],
    worktrees: { total: 2, prunable: 1 },
    worktreeList: [{ main: true }, { main: false, prunable: true }],
  });
  assert.deepEqual(deskIssues(item, [item], 'ja'), [
    { severity: 'red', text: '取得エラー: git failed' },
    { severity: 'red', text: 'main が origin/main より 3 遅れ' },
    { severity: 'red', text: '消えた worktree の残骸 1' },
  ]);
});

test('deskIssues reports current and default branch lag separately when they differ', () => {
  const item = cleanRepo({
    branch: 'feat/work',
    upstream: 'origin/feat/work',
    behind: 2,
    branches: [{ name: 'main', ahead: 0, behind: 5 }],
  });
  assert.deepEqual(deskIssues(item, [item], 'ja').slice(0, 2), [
    { severity: 'red', text: 'feat/work が origin/feat/work より 2 遅れ' },
    { severity: 'red', text: 'main が origin/main より 5 遅れ' },
  ]);
});

test('deskIssues covers every yellow rule including detached HEAD', () => {
  const item = cleanRepo({
    branch: 'feat/work',
    ahead: 4,
    changes: { total: 2 },
    stashCount: 3,
  });
  assert.deepEqual(deskIssues(item, [item], 'ja'), [
    { severity: 'yellow', text: '未コミット 2' },
    { severity: 'yellow', text: '未 push 4' },
    { severity: 'yellow', text: 'feat/work に居る' },
    { severity: 'yellow', text: 'stash 3' },
  ]);
  assert.deepEqual(deskIssues(cleanRepo({ branch: null }), [], 'en'), [
    { severity: 'yellow', text: 'detached HEAD' },
  ]);
});

test('deskIssues reports same-remote peers and locked worktrees as info', () => {
  const item = cleanRepo({ id: 'a', name: 'alpha', group: 'shared', worktreeList: [{ main: true }, { locked: true }] });
  const peerZ = cleanRepo({ id: 'z', name: 'zeta', group: 'shared' });
  const peerB = cleanRepo({ id: 'b', name: 'beta', group: 'shared' });
  assert.deepEqual(deskIssues(item, [item, peerZ, peerB], 'ja'), [
    { severity: 'info', text: '同じ remote: beta, zeta' },
    { severity: 'info', text: 'locked worktree 1' },
  ]);
  assert.deepEqual(deskIssues(item, [item, peerB], 'en')[0], {
    severity: 'info', text: 'Same remote: beta',
  });
});

test('deskRepositoryRows sorts by severity, issue count, then name and groups only clean rows', () => {
  const redStatus = cleanRepo({ id: 'r0', name: 'red-status', status: 'red' });
  const redMany = cleanRepo({ id: 'r2', name: 'red-many', behind: 2, changes: { total: 1 } });
  const yellowB = cleanRepo({ id: 'yb', name: 'beta', status: 'yellow' });
  const yellowA = cleanRepo({ id: 'ya', name: 'alpha', changes: { total: 1 } });
  const infoA = cleanRepo({ id: 'ia', name: 'info-a', group: 'clone' });
  const infoB = cleanRepo({ id: 'ib', name: 'info-b', group: 'clone' });
  const clean = cleanRepo({ id: 'ok', name: 'ok' });
  const listing = deskRepositoryRows({ repositories: [clean, yellowB, infoB, redStatus, yellowA, redMany, infoA] }, 'en');
  assert.deepEqual(listing.actionable.map((row) => [row.repo.id, row.severity]), [
    ['r2', 'red'],
    ['r0', 'red'],
    ['ya', 'yellow'],
    ['yb', 'yellow'],
    ['ia', 'info'],
    ['ib', 'info'],
  ]);
  assert.deepEqual(listing.clean.map((row) => row.repo.id), ['ok']);
});

// Check what the board actually shows: parse with the board's own Markdown subset and read back
// the code spans and the plain text. The subset has no backslash escapes, so a value is right only
// if it comes back unchanged inside a code span.
function rendered(md) {
  const codes = [];
  const texts = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.t === 'code') codes.push(node.v);
    else if (typeof node.v === 'string') texts.push(node.v);
    for (const key of ['inl', 'items', 'children', 'rows', 'cells']) if (node[key]) walk(node[key]);
  };
  walk(parseBoard(md));
  return { codes, text: texts.join(' ') };
}

test('repoMarkdown puts the to-do section directly after status and shows Git values verbatim', () => {
  const md = repoMarkdown(repo, 'ja', [repo]);
  assert.ok(md.indexOf('**状態**') < md.indexOf('## やること'));
  assert.ok(md.indexOf('## やること') < md.indexOf('**ブランチ**'));
  const { codes, text } = rendered(md);
  assert.ok(codes.includes('Stira *desk* <x>'), codes.join(' | '));
  assert.match(text, /feat\/\[desk\] が origin\/feat\/desk より 3 遅れ/);
  // no repository name is ever wrapped in **...** around a code span (the backticks would show)
  assert.doesNotMatch(md, /\*\*`/);
  assert.ok(codes.some((c) => c.includes('fix \u02b9desk\u02b9 <script>')), codes.join(' | '));
  assert.doesNotMatch(text, /\\/);
  assert.match(md, /staged 1 · unstaged 2 · untracked 3/);
  assert.match(repoMarkdown(cleanRepo(), 'ja'), /## やること\nなし/);
});

test('repoMarkdown shows a Windows path and an error without backslash doubling', () => {
  const md = repoMarkdown({ name: 'bad #repo', path: 'X:\\bad\\a_b_c', error: 'git <failed>', status: 'red' }, 'en');
  assert.match(md, /## To do/);
  const { codes, text } = rendered(md);
  assert.ok(codes.includes('bad #repo'));
  assert.ok(codes.includes('X:\\bad\\a_b_c'), codes.join(' | '));
  assert.ok(codes.includes('git <failed>'));
  assert.doesNotMatch(text, /\\\\/);
});

test('deskMarkdown flattens the map to one list level the board can draw', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('../tools/harness/fixtures/repos.json', import.meta.url), 'utf8'));
  const md = deskMarkdown(fixture, 'ja');
  assert.match(md, /^# 作業机/);
  // no indented (nested) list items: the board would merge them into the parent item
  assert.doesNotMatch(md, /^[ \t]+- /m);
  assert.match(md, /^## `C:\\example\\projects`$/m);
  assert.match(md, /^\*\*同じ remote\*\*: `example\/stage`$/m);
  assert.match(md, /^- `stage-primary` · 作業中$/m);
  assert.match(md, /^- [├└] \* `feat\/workbench-desk` · ↑8$/m);
  assert.match(md, /^- [├└] ⎇ `C:\\example\\scratch\\pr24-worktree-with-a-very-long-path` · `pr24-review` · locked$/m);
  const blocks = parseBoard(md);
  const lists = blocks.filter((b) => b.t === 'ul');
  assert.ok(lists.length >= 3);
  for (const list of lists) for (const item of list.items) {
    assert.doesNotMatch(JSON.stringify(item), /\n- |\s- [├└]/, 'a child line was merged into its parent item');
  }
  assert.match(deskMarkdown(fixture, 'en'), /^\*\*Same remote\*\*: `example\/stage`$/m);
});

test('empty workbench explains that configuration is empty', () => {
  assert.match(deskMarkdown({ repositories: [] }, 'ja'), /まだ登録されていません/);
  assert.match(deskMarkdown({ repositories: [] }, 'en'), /No repositories are configured/);
});

test('desk hotspot uses the decided labels and desk rectangle key', () => {
  const desk = SPOTS.find((spot) => spot.id === 'desk');
  assert.deepEqual({ key: desk.key, ja: desk.ja, en: desk.en }, { key: 'bgDesk', ja: '作業机', en: 'WORKBENCH' });
});

test('worstStatus selects red, then yellow, otherwise green', () => {
  assert.equal(worstStatus({ repositories: [{ status: 'green' }, { status: 'yellow' }] }), 'yellow');
  assert.equal(worstStatus({ repositories: [{ status: 'yellow' }, { status: 'red' }] }), 'red');
  assert.equal(worstStatus({ repositories: [{ status: 'green' }] }), 'green');
  assert.equal(worstStatus({ repositories: [] }), 'green');
});

test('noteLayout is stable, reports overflow, and paints red notes last', () => {
  const repositories = Array.from({ length: 14 }, (_, index) => ({
    id: `repo-${index}`,
    status: index === 3 || index === 8 ? 'red' : index % 2 ? 'yellow' : 'green',
  }));
  const first = noteLayout(repositories);
  const second = noteLayout([...repositories]);
  assert.deepEqual(
    first.notes.map(({ repo: item, slot, x, y, kind, tilt }) => ({ id: item.id, slot, x, y, kind, tilt })),
    second.notes.map(({ repo: item, slot, x, y, kind, tilt }) => ({ id: item.id, slot, x, y, kind, tilt })),
  );
  assert.ok(new Set(first.notes.map((n) => n.kind)).size > 1);
  assert.ok(new Set(first.notes.map((n) => n.tilt)).size > 1);
  for (const n of first.notes) {
    assert.ok(NOTE_KINDS.includes(n.kind));
    assert.ok(Number.isInteger(n.tilt) && n.tilt >= 0 && n.tilt < NOTE_TILTS);
    assert.ok(Number.isInteger(n.x) && Number.isInteger(n.y));
  }
  assert.equal(first.notes.length, 12);
  assert.equal(first.rest, 2);
  const firstRed = first.notes.findIndex((note) => note.status === 'red');
  assert.ok(firstRed >= 0);
  assert.ok(first.notes.slice(firstRed).every((note) => note.status === 'red'));
});

test('repositoryStatus maps statuses and forces read errors to red', () => {
  assert.equal(repositoryStatus({ status: 'green' }), 'green');
  assert.equal(repositoryStatus({ status: 'yellow' }), 'yellow');
  assert.equal(repositoryStatus({ status: 'green', error: 'git failed' }), 'red');
  assert.equal(repositoryStatus({ status: 'unknown' }), 'red');
});

test('newlyRedRepositoryIds detects only transitions after the initial payload', () => {
  const before = { repositories: [
    { id: 'steady-red', status: 'red' },
    { id: 'turns-red', status: 'yellow' },
    { id: 'steady-green', status: 'green' },
  ] };
  const after = { repositories: [
    { id: 'steady-red', status: 'red' },
    { id: 'turns-red', status: 'red' },
    { id: 'steady-green', status: 'green' },
    { id: 'new-red', status: 'red' },
  ] };
  assert.deepEqual(newlyRedRepositoryIds(null, after), []);
  assert.deepEqual(newlyRedRepositoryIds(before, after), ['turns-red']);
});

test('gradeFilter converts room dim and desaturation to CSS filter values', () => {
  assert.equal(gradeFilter(null), '');
  assert.equal(gradeFilter({ dim: 0, desat: 0, ambient: [1, 1, 1] }), 'brightness(100%) saturate(100%)');
  assert.equal(gradeFilter({ dim: 0.25, desat: 0.4, ambient: [1, 0.8, 1.2] }), 'brightness(75%) saturate(60%)');
});

test('noteSprite picks the atlas cell by kind, tilt and status', () => {
  assert.deepEqual(noteSprite({ kind: 'note', tilt: 0, status: 'red' }), { x: 0, y: 0 });
  assert.deepEqual(noteSprite({ kind: 'tape', tilt: 1, status: 'yellow' }), { x: 4 * NOTE_WORLD_SIZE, y: NOTE_WORLD_SIZE });
  assert.deepEqual(noteSprite({ kind: 'pin', tilt: 2, status: 'green' }), { x: 8 * NOTE_WORLD_SIZE, y: 2 * NOTE_WORLD_SIZE });
  assert.deepEqual(noteSprite({ kind: 'x', tilt: 9, status: 'x' }), { x: 2 * NOTE_WORLD_SIZE, y: 0 });
});


test('folder settings trim pasted quotes, ignore empty values, and deduplicate without changing first spelling', () => {
  assert.equal(normalizeDeskPath('  "C:\\example\\Repo"  '), 'C:\\example\\Repo');
  assert.equal(normalizeDeskPath('   '), '');
  assert.deepEqual(uniqueDeskPaths([
    ' C:\\example\\Repo ',
    'c:\\EXAMPLE\\repo',
    '"C:\\example\\Other"',
    '',
  ]), ['C:\\example\\Repo', 'C:\\example\\Other']);
});

test('folder setting problems map to their submitted field and row', () => {
  const mapped = deskConfigProblemMap([
    { field: 'paths', index: 1, reason: 'path does not exist' },
    { field: 'scanRoots', index: 0, reason: 'junctions are not allowed' },
    { field: 'other', index: 0, reason: 'ignored' },
  ]);
  assert.equal(mapped.get('paths:1'), 'path does not exist');
  assert.equal(mapped.get('scanRoots:0'), 'junctions are not allowed');
  assert.equal(mapped.has('other:0'), false);
  assert.equal(deskConfigProblemMap([
    { field: 'paths', index: 0, reason: 'path does not exist' },
  ], 'ja').get('paths:0'), 'パスが見つかりません');
});

test('empty workbench state distinguishes missing configuration from an empty scan result', () => {
  const empty = { repositories: [] };
  assert.equal(deskEmptyState({ paths: [], scanRoots: [] }, empty), 'unconfigured');
  assert.equal(deskEmptyState({ paths: [], scanRoots: ['C:\\example\\projects'] }, empty), 'not-found');
  assert.equal(deskEmptyState({ paths: ['C:\\example\\repo'], scanRoots: [] }, { repositories: [{}] }), null);
});


test('every fixed folder-setting reason from the backend has a Japanese text', () => {
  // The page translates the backend's English reason by exact text. If backend/repos.py words a
  // reason differently, the Japanese page would silently fall back to English: catch it here.
  const source = fs.readFileSync(new URL('../backend/repos.py', import.meta.url), 'utf8');
  const fixed = [...source.matchAll(/"reason":\s*"([^"{]+)"/g)].map((m) => m[1]);
  assert.ok(fixed.length >= 6, fixed.join(' | '));
  for (const reason of new Set(fixed)) {
    const shown = deskConfigProblemMap([{ field: 'paths', index: 0, path: 'x', reason }], 'ja').get('paths:0');
    assert.notEqual(shown, reason, `no Japanese text for: ${reason}`);
  }
});



test('deskDashboardRecord keeps counts, workbench order, limits, and no personal paths', () => {
  const privatePath = 'C:\\Users\\someone\\secret\\repo';
  const repositories = [
    cleanRepo({ id: 'green', name: 'green-repo', path: privatePath }),
    cleanRepo({ id: 'yellow', name: 'yellow-repo', status: 'yellow', changes: { total: 1 }, path: privatePath }),
    cleanRepo({ id: 'red', name: 'red-repo', status: 'red', behind: 2, path: privatePath }),
  ];
  for (let index = 0; index < 9; index += 1) {
    repositories.push(cleanRepo({
      id: `extra-${index}`,
      name: `extra-${String(index).padStart(2, '0')}`,
      status: 'yellow',
      changes: { total: 1 },
      error: index === 0 ? 'あ'.repeat(180) : undefined,
      path: `${privatePath}-${index}`,
    }));
  }
  const payload = { generatedAt: '2026-11-07T01:02:03Z', repositories };
  const listing = deskRepositoryRows(payload, 'ja');
  const data = deskDashboardRecord(payload, 'ja');
  assert.deepEqual({ red: data.red, yellow: data.yellow, green: data.green, total: data.total }, {
    red: 2, yellow: 9, green: 1, total: 12,
  });
  assert.deepEqual(data.needs.map((item) => item.name), listing.actionable.slice(0, 8).map((row) => row.repo.name));
  assert.equal(data.needs.length, 8);
  assert.ok(data.needs.every((item) => ['!', '·'].includes(item.mark)));
  assert.ok(data.needs.every((item) => Array.from(item.text).length <= 120));
  assert.equal(data.clean, 1);
  assert.equal(data.generatedAt, payload.generatedAt);
  assert.doesNotMatch(JSON.stringify(data), /Users|secret|\\\\/);
});


test('deskDashboardRecord removes trailing needs until the data fits in 8 KiB', () => {
  const repositories = Array.from({ length: 8 }, (_, index) => cleanRepo({
    id: `large-${index}`,
    name: `${index}-${'界'.repeat(3000)}`,
    status: 'yellow',
    changes: { total: 1 },
  }));
  const data = deskDashboardRecord({ generatedAt: '2026-11-07T01:02:03Z', repositories }, 'ja');
  assert.ok(new TextEncoder().encode(JSON.stringify(data)).byteLength <= 8 * 1024);
  assert.ok(data.needs.length < 8);
});


test('dashboard send decision skips identical data until five minutes after success', () => {
  const data = { total: 1 };
  const first = deskDashboardSendDecision(null, 'desk-bot', data, 0);
  assert.equal(first.send, true);
  const sent = { bot: first.bot, signature: first.signature, at: 1000, outcome: 'sent' };
  assert.equal(deskDashboardSendDecision(sent, 'desk-bot', data, 1000 + 299999).send, false);
  assert.equal(deskDashboardSendDecision(sent, 'desk-bot', data, 1000 + 300000).send, true);
  assert.equal(deskDashboardSendDecision(sent, '', data, 1000 + 300000).send, false);
});


test('dashboard send decision does not retry the same failed data', () => {
  const data = { total: 1 };
  const first = deskDashboardSendDecision(null, 'desk-bot', data, 0);
  const failed = { bot: first.bot, signature: first.signature, at: 0, outcome: 'failed' };
  assert.equal(deskDashboardSendDecision(failed, 'desk-bot', data, 999999).send, false);
  assert.equal(deskDashboardSendDecision(failed, 'desk-bot', { total: 2 }, 1).send, true);
  assert.equal(deskDashboardSendDecision(failed, 'other-bot', data, 1).send, true);
});


test('dashboard send decision retries quota refusal only on the next five-minute cycle', () => {
  const data = { total: 1 };
  const first = deskDashboardSendDecision(null, 'desk-bot', data, 0);
  const quota = { bot: first.bot, signature: first.signature, at: 1000, outcome: 'quota' };
  assert.equal(deskDashboardSendDecision(quota, 'desk-bot', data, 1000 + 299999).send, false);
  assert.equal(deskDashboardSendDecision(quota, 'desk-bot', { total: 2 }, 1000 + 299999).send, false);
  assert.equal(deskDashboardSendDecision(quota, 'desk-bot', data, 1000 + 300000).send, true);
});


test('dashboardBot validation reasons have Japanese UI text', () => {
  const reasons = [
    'dashboardBot must be a string',
    'dashboardBot must be at most 64 characters',
    'dashboardBot must contain only lowercase letters, digits, hyphens, and underscores',
  ];
  for (const reason of reasons) {
    const shown = deskConfigProblemMap([{ field: 'dashboardBot', index: 0, reason }], 'ja');
    assert.notEqual(shown.get('dashboardBot:0'), reason);
  }
});
