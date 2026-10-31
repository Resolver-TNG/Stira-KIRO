// Stage のフレームを撮る(依存なし: Node の http と、Chrome をパイプの DevTools で動かす)。
//
//   node tools/frames.mjs --state memory --from 0 --to 120 --step 4 [--size 1180x670] [--out DIR]
//   node tools/frames.mjs --list            (デモの状態の一覧)
//
// frames=N の固定刻み(1/60 秒)で N フレーム進めて止まった絵を、N ごとに撮る。同じ入力なら
// 同じ絵になるので、前後のフレームを画素で比べられる(tools/analyze_frames.py)。
// 出力: DIR/f0000.png … と DIR/frames.json(各フレームのモーション・顔・拡大率など)。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).join(' ').split(/\s+--/).filter(Boolean).map((s) => {
  const [k, ...v] = s.replace(/^--/, '').split(/\s+/);
  return [k, v.join(' ') || true];
}));

if (args.list) {
  const src = fs.readFileSync(path.join(REPO, 'ui/stage/js/director.js'), 'utf8')
    + fs.readFileSync(path.join(REPO, 'ui/stage/js/demo_motions.js'), 'utf8')
    + fs.readFileSync(path.join(REPO, 'ui/stage/js/demo_gadgets.js'), 'utf8');
  console.log([...new Set([...src.matchAll(/^\s+id: '([\w-]+)'/gm)].map((m) => m[1]))].join('\n'));
  process.exit(0);
}

const STATE = String(args.state || 'calm');
const FROM = Number(args.from ?? 0);
const TO = Number(args.to ?? 120);
const STEP = Math.max(1, Number(args.step ?? 4));
const [W, H] = String(args.size || '1180x670').split('x').map(Number);
const SEED = Number(args.seed || 341);
const OUT = path.resolve(String(args.out || path.join(process.env.KIROCREW_SCRATCH || os.tmpdir(), 'stira-frames', `${STATE}-${W}x${H}`)));
const EXTRA = typeof args.query === 'string' ? `&${args.query}` : '';

const CHROME = [process.env.CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p) => p && fs.existsSync(p));
if (!CHROME) {
  console.error('Chrome / Edge が見つかりません(CHROME で指定できます)');
  process.exit(2);
}

// --- 静的サーバ(127.0.0.1 だけ、リポジトリの中だけ) --------------------------------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const file = path.resolve(REPO, '.' + decodeURIComponent(u.pathname));
  if (!file.startsWith(REPO + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

// --- Chrome(DevTools をパイプで) ---------------------------------------------------------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stira-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--remote-debugging-pipe', `--user-data-dir=${profile}`, `--window-size=${W},${H}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let seq = 0;
const waits = new Map();
const logs = [];
let buf = Buffer.alloc(0);
chrome.stdio[4].on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  let i;
  while ((i = buf.indexOf(0)) >= 0) {
    const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
    buf = buf.subarray(i + 1);
    if (msg.id && waits.has(msg.id)) {
      const w = waits.get(msg.id);
      waits.delete(msg.id);
      if (msg.error) w.reject(new Error(`${w.method}: ${msg.error.message}`));
      else w.resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown') {
      const p = msg.params;
      logs.push(p.exceptionDetails ? `exception: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}` : `${p.type}: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
  }
});
function send(method, params = {}, sessionId) {
  const id = ++seq;
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  return new Promise((resolve, reject) => waits.set(id, { resolve, reject, method }));
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable');
await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

async function evaluate(expression) {
  const r = await S('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const report = { state: STATE, size: [W, H], seed: SEED, step: STEP, chrome: path.basename(CHROME), frames: [] };
for (let n = Math.max(1, FROM); n <= TO; n += STEP) {
  const url = `http://127.0.0.1:${PORT}/tools/harness/stage.html?state=${encodeURIComponent(STATE)}&frames=${n}&seed=${SEED}&instant=1${EXTRA}`;
  await S('Page.navigate', { url });
  let info = null;
  for (let t = 0; t < 400; t += 1) {
    await sleep(50);
    try {
      info = await evaluate(`(() => { const r = window.__stira && window.__stira.root; if (!r) return null;
        const d = r.dataset; if (d.ready === 'error') return { error: true };
        if (d.frozen !== '1') return null;
        const c = r.querySelector('#view').getBoundingClientRect(); const s = r.querySelector('#stage').getBoundingClientRect();
        return { frame: d.charFrame || '', face: d.charFace || '', step: d.step || '', render: d.render || '', layout: r.stiraLayout || null,
          view: [c.left, c.top, c.width, c.height], stage: [s.left, s.top, s.width, s.height] }; })()`);
    } catch {
      info = null;
    }
    if (info) break;
  }
  if (!info || info.error) {
    report.frames.push({ n, error: info ? 'stage failed to load' : 'timeout' });
    console.error(`frame ${n}: ${info ? 'load error' : 'timeout'}`);
    continue;
  }
  const [x, y, w, h] = info.view;
  const shot = await S('Page.captureScreenshot', { format: 'png', clip: { x, y, width: w, height: h, scale: 1 } });
  const name = `f${String(n).padStart(4, '0')}.png`;
  fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, 'base64'));
  report.frames.push({ n, t: +(n / 60).toFixed(3), file: name, ...info });
  process.stdout.write(`\r${name} ${info.frame}`.padEnd(70));
}
report.console = logs.slice(0, 50);
fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(report, null, 1));
console.log(`\n${report.frames.length} frames -> ${OUT}`);
chrome.kill();
server.close();
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* Chrome may still hold it for a moment */
}
