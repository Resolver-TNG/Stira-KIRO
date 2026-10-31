// 解析台: 本番のページ(ui/dist/index.mjs)と同じ手順で Stage を組み、demo モードで動かす。
// URL の ?state=<デモの状態>&frames=N&seed=S は StiraCore main.js がそのまま読む
// (frames=N: 1/60 秒刻みで N フレーム進めて止まる → 同じ入力なら同じ絵)。
import { TEMPLATE } from '../../ui/stage/kc_template.js';

const base = new URL('../../ui/stage/', import.meta.url).href;
const root = document.createElement('div');
root.id = 'stira-stage-root';
root.className = 'stira-stage-root';
root.innerHTML = TEMPLATE;
// demo: 会話なし、director.js の状態を再生する
root.querySelector('#stira-app').dataset.stage = 'demo';

const catalog = { ja: {}, en: {} };
for (const lang of ['ja', 'en']) {
  try {
    const r = await fetch(`${base}i18n/catalog.${lang}.json`);
    if (r.ok) catalog[lang] = await r.json();
  } catch {
    /* keys are shown */
  }
}
const data = document.createElement('script');
data.type = 'application/json';
data.id = 'i18n-catalog';
data.textContent = JSON.stringify(catalog);
root.append(data);
document.getElementById('host').append(root);
try {
  localStorage.setItem('stira.lang', 'ja');
} catch {
  /* ignore */
}
window.__stira = { root };
await import(`${base}js/main.js`);
