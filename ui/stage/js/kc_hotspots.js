// Stira-KIRO: places in the room you can press. The shelf is the memory's table of contents,
// the window looks out at the forest, and the desk shows local Git repositories. A place with
// no handler yet falls back to a short "coming soon" tag.
//
// Positions come from the room art (assets/bg/bg.json: image coords, 640 x 340) and the layout
// main.js reports ('stira:layout': scale, view). Image -> screen: x - viewLeft(vw), y - 10
// (the view's top row), times the integer scale. The hotspots hide while the board is down
// (CSS), since the board covers the shelf.

const VIEW_TOP_ROW = 10; // scene.js: WORLD_H - VIEW_TOP
const viewLeft = (vw) => Math.round(320 - vw / 2); // scene.js viewLeft

export const SPOTS = [
  { id: 'shelf', key: 'bgShelf', ja: '記憶の棚', en: 'MEMORY', soonJa: '準備中…本が並ぶ予定', soonEn: 'COMING SOON' },
  { id: 'window', key: 'bgWindow', ja: '窓の外の森', en: 'FOREST', soonJa: '準備中…森が見える予定', soonEn: 'COMING SOON' },
  { id: 'desk', key: 'bgDesk', ja: '作業机', en: 'WORKBENCH', soonJa: '準備中…作業場所が並ぶ予定', soonEn: 'COMING SOON' },
];

export function spotRect(rect, { scale, view }) {
  const [x, y, w, h] = rect;
  return { left: (x - viewLeft(view[0])) * scale, top: (y - VIEW_TOP_ROW) * scale, width: w * scale, height: h * scale };
}

export async function startHotspots({ root, stage, base, lang, onPress }) {
  let meta = null;
  try {
    meta = await (await fetch(`${base}/bg/bg.json`)).json();
  } catch {
    return null;
  }
  // the whole bookcase as drawn (rects.shelf), not only its lit middle (meta.shelf)
  const rects = {
    bgShelf: (meta.rects && meta.rects.shelf) || meta.shelf,
    bgWindow: meta.window,
    bgDesk: meta.rects && meta.rects.desk,
  };
  const nodes = SPOTS.filter((s) => Array.isArray(rects[s.key])).map((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kc-hotspot';
    b.dataset.spot = s.id;
    b.setAttribute('aria-label', lang === 'ja' ? s.ja : s.en);
    const tag = document.createElement('span');
    tag.className = 'kc-hotspot-tag';
    tag.textContent = lang === 'ja' ? s.ja : s.en;
    b.append(tag);
    b.addEventListener('click', () => {
      if (onPress && onPress(s.id)) return;
      tag.textContent = lang === 'ja' ? s.soonJa : s.soonEn;
      b.dataset.soon = '1';
      clearTimeout(b.soonTimer);
      b.soonTimer = setTimeout(() => {
        tag.textContent = lang === 'ja' ? s.ja : s.en;
        delete b.dataset.soon;
      }, 2600);
    });
    stage.append(b);
    return { s, b, rect: rects[s.key] };
  });
  const place = (geo) => {
    const canvas = stage.querySelector('#view');
    const off = canvas ? { x: canvas.offsetLeft, y: canvas.offsetTop } : { x: 0, y: 0 };
    for (const n of nodes) {
      const r = spotRect(n.rect, geo);
      // clip to the drawn view (a spot partly outside it keeps only the visible part)
      const vw = geo.view[0] * geo.scale;
      const vh = geo.view[1] * geo.scale;
      const left = Math.max(0, r.left);
      const top = Math.max(0, r.top);
      const width = Math.max(0, Math.min(vw, r.left + r.width) - left);
      const height = Math.max(0, Math.min(vh, r.top + r.height) - top);
      n.b.hidden = width < 24 || height < 24;
      Object.assign(n.b.style, { left: `${off.x + left}px`, top: `${off.y + top}px`, width: `${width}px`, height: `${height}px` });
      // no room above for the plate: it goes inside the spot
      if (top < 30 * Math.max(1, geo.scale / 3)) n.b.dataset.inside = '1';
      else delete n.b.dataset.inside;
    }
  };
  root.addEventListener('stira:layout', (e) => place(e.detail));
  if (root.stiraLayout) place(root.stiraLayout); // the Stage laid out before the art was read
  return { place };
}
