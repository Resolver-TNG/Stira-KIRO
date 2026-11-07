// 作業机の確認台。本番と同じ Stage shell、hotspot、desk controller/picker/Markdown を使う。
import { TEMPLATE } from '../../ui/stage/kc_template.js';
import { startHotspots } from '../../ui/stage/js/kc_hotspots.js';
import { deskMarkdown, openDeskPicker, repoMarkdown, startDeskStatus } from '../../ui/stage/js/kc_desk.js';
import { classify } from '../../ui/stage/js/markdown.js';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'ja';
const base = new URL('../../ui/stage/', import.meta.url).href;
const fixtureUrl = new URL('fixtures/repos.json', import.meta.url);
const fixture = await fetch(fixtureUrl).then((response) => response.json());
const dashboardBot = params.get('bot') || '';
const dashboardStatus = Number(params.get('botStatus') || 200);
const sent = [];
let payload = structuredClone(fixture);
let config = {
  scanRoots: ['C:\\example\\projects', 'C:\\example\\labs'],
  paths: ['C:\\example\\listed-tooling'],
  scanDepth: 1,
  dashboardBot,
};
if (params.get('empty') === '1') {
  payload = { ...payload, repositories: [] };
  config = { scanRoots: [], paths: [], scanDepth: 1, dashboardBot };
}
if (params.get('problem') === '1') {
  config = { ...config, paths: [...config.paths, 'C:\\example\\missing-repository'] };
}
const count = Math.max(0, Math.floor(Number(params.get('count')) || 0));
if (count > payload.repositories.length) {
  const baseRepositories = [...payload.repositories];
  const statuses = ['green', 'yellow', 'green', 'red', 'green'];
  for (let index = baseRepositories.length; index < count; index += 1) {
    const source = baseRepositories[index % baseRepositories.length];
    payload.repositories.push({
      ...source,
      id: `local-fixture-${index}`,
      name: `fixture-repo-${index}`,
      status: statuses[index % statuses.length],
      error: undefined,
    });
  }
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

async function apiFetch(url, init = {}) {
  const target = new URL(url, location.href);
  const member = target.pathname.match(/^\/api\/member-records\/([^/]+)$/);
  if (member && init.method === 'POST') {
    let submitted = {};
    try { submitted = JSON.parse(init.body); } catch { return jsonResponse({ error: 'json body required' }, 400); }
    sent.push(submitted);
    root.dataset.sent = JSON.stringify(sent);
    const codes = {
      403: 'app_token_required',
      404: 'member_not_found',
      409: 'crew_log_unavailable',
      429: 'quota_exceeded',
      503: 'crew_log_off',
    };
    return dashboardStatus === 200
      ? jsonResponse({ ok: true, recorded: { type: 'stira_kiro__desk', member: decodeURIComponent(member[1]) } })
      : jsonResponse({ error: 'fake member record refusal', code: codes[dashboardStatus] || 'fake_error' }, dashboardStatus);
  }
  if (target.pathname.endsWith('/api/apps/stira-kiro/repos/config') && (!init.method || init.method === 'GET')) {
    return jsonResponse(config);
  }
  if (target.pathname.endsWith('/api/apps/stira-kiro/repos/config') && init.method === 'PUT') {
    await new Promise((resolve) => setTimeout(resolve, 450));
    let submitted = {};
    try { submitted = JSON.parse(init.body); } catch { return jsonResponse({ error: 'json body required' }, 400); }
    const problems = [];
    for (const field of ['scanRoots', 'paths']) {
      (Array.isArray(submitted[field]) ? submitted[field] : []).forEach((path, index) => {
        if (String(path).toLocaleLowerCase('en-US').includes('missing')) {
          problems.push({ field, index, path, reason: 'path does not exist' });
        }
      });
    }
    if (problems.length) {
      return jsonResponse({ error: 'one or more repository paths were rejected', problems }, 422);
    }
    config = {
      scanRoots: [...submitted.scanRoots],
      paths: [...submitted.paths],
      scanDepth: 1,
      dashboardBot: typeof submitted.dashboardBot === 'string' ? submitted.dashboardBot : '',
    };
    return jsonResponse({ config, found: payload.repositories.length });
  }
  if (target.pathname.endsWith('/api/apps/stira-kiro/repos') && (!init.method || init.method === 'GET')) {
    return jsonResponse(payload);
  }
  const match = target.pathname.match(/\/api\/apps\/stira-kiro\/repos\/([^/]+)\/fetch$/);
  if (match && init.method === 'POST') {
    await new Promise((resolve) => setTimeout(resolve, 450));
    const id = decodeURIComponent(match[1]);
    const repo = payload.repositories.find((item) => item.id === id);
    if (!repo) return jsonResponse({ error: 'repository not found' }, 404);
    const updated = {
      ...repo,
      status: repo.changes && repo.changes.total ? 'yellow' : 'green',
      behind: 0,
      fetchHeadUpdatedAt: '2026-11-06T07:05:00Z',
      branches: Array.isArray(repo.branches)
        ? repo.branches.map((branch) => ({ ...branch, behind: 0 }))
        : repo.branches,
      worktrees: { ...(repo.worktrees || {}), prunable: 0 },
    };
    payload = { ...payload, repositories: payload.repositories.map((item) => item.id === id ? updated : item) };
    return jsonResponse(updated);
  }
  return jsonResponse({ error: 'not found' }, 404);
}

const root = document.createElement('div');
root.id = 'stira-stage-root';
root.className = 'stira-stage-root';
root.innerHTML = TEMPLATE;
root.querySelector('#stira-app').dataset.stage = 'demo';

const catalog = { ja: {}, en: {} };
for (const code of ['ja', 'en']) {
  try {
    const response = await fetch(`${base}i18n/catalog.${code}.json`);
    if (response.ok) catalog[code] = await response.json();
  } catch {
    /* keys remain visible */
  }
}
const data = document.createElement('script');
data.type = 'application/json';
data.id = 'i18n-catalog';
data.textContent = JSON.stringify(catalog);
root.append(data);
document.getElementById('host').append(root);
try {
  localStorage.setItem('stira.lang', lang);
} catch {
  /* storage refused */
}
window.__stira = { root, sent };
await import(`${base}js/main.js`);

const waitForStage = async () => {
  for (let count = 0; count < 400; count += 1) {
    if (root.dataset.ready === '1') return;
    if (root.dataset.ready === 'error') throw new Error('Stage failed to load');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Stage timed out');
};
await waitForStage();

const stage = root.querySelector('#stage');
let deskStatus = null;
const onPress = (id) => {
  if (id !== 'desk') return false;
  void openDeskPicker({ root, apiFetch, classify, lang, deskStatus });
  return true;
};
await startHotspots({ root, stage, base: `${base}assets`, lang, onPress });
deskStatus = startDeskStatus({ root, stage, apiFetch, classify, lang });
await deskStatus.ready;

if (['picker', 'settings'].includes(params.get('open'))) {
  await openDeskPicker({
    root,
    apiFetch,
    classify,
    lang,
    deskStatus,
    initialView: params.get('open') === 'settings' ? 'settings' : 'list',
  });
  if (params.get('problem') === '1') {
    const save = root.querySelector('.kc-desk-config-save');
    if (save) save.click();
    for (let attempt = 0; attempt < 80 && !root.querySelector('.kc-desk-config-error'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
} else if (params.get('open') === 'board') {
  const repo = payload.repositories.find((item) => item.id === params.get('repo'));
  const note = [...stage.querySelectorAll('.kc-desk-note')].find((item) => item.dataset.repoId === (repo && repo.id));
  if (note) {
    note.click(); // exercise the production note -> repoMarkdown -> board path
  } else {
    const text = repo ? repoMarkdown(repo, lang, payload.repositories) : deskMarkdown(payload, lang);
    root.stiraBoard.show({ key: repo ? `repo-${repo.id}` : 'desk-preview', text, c: classify(text) }, { explicit: true });
  }
} else if (params.get('open') === 'overview') {
  const text = deskMarkdown(payload, lang);
  root.stiraBoard.show({ key: 'desk-overview-preview', text, c: classify(text) }, { explicit: true });
}
root.dataset.harnessReady = '1';
window.__stira = { root, deskStatus, payload: () => payload, sent };
