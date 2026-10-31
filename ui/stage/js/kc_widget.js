// Stira-KIRO: KiroCrew's <mcwidget> replies, drawn on the Stage's whiteboard.
//
// toWidgetFences(text): <mcwidget ...>HTML</mcwidget> -> a ````mcwidget fenced block, so the
//   Stage's Markdown subset sees a code block (the reply goes to the board) and the HTML is
//   never parsed as Markdown.
// widgetFrame(doc, html): the widget in an iframe that can run nothing and load nothing:
//   sandbox="allow-same-origin" (no allow-scripts: no script runs inside, no form, no popup,
//   no navigation of the dashboard; same-origin only so this page can read its height),
//   plus a CSP inside the document: default-src 'none', inline styles only, data: images.
//   The dashboard's theme variables the widget names are copied in, so it looks as it does
//   in a KiroCrew chat. Interactive widgets show their static markup only.

export const WIDGET_LIMIT = 64 * 1024;
const MAX_HEIGHT = 1600;
const RE = /<mcwidget\b([^>]*)>([\s\S]*?)<\/mcwidget>/gi;

// KiroCrew's choice line: a final `[OPTIONS: a | b | c]`. On the Stage it is buttons
// (kc_live.js), never text on the board, in the line or in the log.
const OPTIONS_LINE = /^[ \t]*\[OPTIONS:([^\]\n]{1,2000})\][ \t]*$/gim;

export function extractOptions(text) {
  if (typeof text !== 'string') return [];
  let last = null;
  for (const m of text.matchAll(OPTIONS_LINE)) last = m[1];
  if (!last) return [];
  return last.split('|').map((s) => s.trim().slice(0, 120)).filter(Boolean).slice(0, 6);
}

// What the Stage's Markdown subset reads: options removed, widgets fenced.
export function prepareReply(text) {
  if (typeof text !== 'string') return text;
  return toWidgetFences(text.replace(OPTIONS_LINE, '').replace(/\s+$/, ''));
}

export function toWidgetFences(text) {
  if (typeof text !== 'string' || !/<mcwidget\b/i.test(text)) return text;
  return text.replace(RE, (_m, _attrs, body) => `\n\n\`\`\`\`mcwidget\n${String(body).replace(/^\n+|\n+$/g, '')}\n\`\`\`\`\n\n`);
}

function themeCss(html) {
  const names = new Set();
  for (const m of html.matchAll(/var\(\s*(--[A-Za-z0-9_-]{1,60})/g)) names.add(m[1]);
  for (const n of ['--bg', '--text', '--card', '--card-fg', '--border', '--muted', '--accent', '--font-sans', '--font-mono']) names.add(n);
  const cs = getComputedStyle(document.documentElement);
  const rows = [];
  for (const n of names) {
    const v = cs.getPropertyValue(n).trim();
    // a value is copied only if it cannot close the rule or the style element
    if (v && !/[<>{};]|\burl\(|@import|expression\(/i.test(v)) rows.push(`${n}: ${v};`);
  }
  return `:root { ${rows.join(' ')} }
html, body { margin: 0; padding: 0; background: transparent; color: var(--text, #222); font-family: var(--font-sans, system-ui, sans-serif); font-size: 14px; }
body { padding: 4px; }`;
}

export function widgetFrame(doc, html) {
  if (typeof html !== 'string' || !html.trim() || html.length > WIDGET_LIMIT) return null;
  // scripts could not run anyway (sandbox); dropping them keeps the source short and honest
  const body = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*>/gi, '');
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
  const src = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${themeCss(body)}</style></head><body>${body}</body></html>`;
  const box = doc.createElement('div');
  box.className = 'md-code md-widget';
  const frame = doc.createElement('iframe');
  frame.className = 'md-widget-frame';
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('loading', 'eager');
  frame.setAttribute('title', 'widget');
  frame.style.cssText = 'display:block;width:100%;height:160px;border:0;background:transparent;';
  frame.addEventListener('load', () => {
    try {
      const d = frame.contentDocument;
      const hgt = d ? Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0) : 0;
      if (hgt > 0) frame.style.height = `${Math.min(MAX_HEIGHT, hgt + 4)}px`;
    } catch {
      /* stays at its first height */
    }
  });
  frame.srcdoc = src;
  const details = doc.createElement('details');
  details.className = 'md-svg-src';
  const summary = doc.createElement('summary');
  summary.textContent = 'HTML';
  const pre = doc.createElement('pre');
  pre.textContent = html;
  details.append(summary, pre);
  box.append(frame, details);
  return box;
}
