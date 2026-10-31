// Stira-KIRO page: the Stage inside the KiroCrew dashboard.
//
// Hand-written ESM, no build step: React and the App SDK come from the host's import map.
// The Stage itself is StiraCore's plain-JS Stage (ui/stage/, synced by tools/sync_stage.mjs)
// and is loaded from this app's UI directory at mount. This file only:
//   1. draws the Stage's DOM (a constant template: no data from anywhere goes into it),
//   2. hands the Stage a fetch bound to the app's scoped API client (useAppApi().raw),
//      the KiroCrew chat core (kc_core.js) and a confirmation dialog (kc_confirm.js),
//   3. imports the Stage's entry module once per mount; the Stage stops by itself when its
//      root leaves the document.
import React, { useEffect, useRef, useState } from 'react'
import { useAppApi } from '@kirocrew/app-sdk'

const h = React.createElement
const APP = 'stira-kiro'

function stageBase() {
  try {
    return new URL('../stage/', import.meta.url).href
  } catch {
    return `/apps/${APP}/ui/stage/`
  }
}

let mountSeq = 0

// The DOM of StiraCore's templates/stage.html (the shell page), minus what KiroCrew owns or
// this milestone leaves out (approvals, YOLO / allowance slots, progress, image attach).
// the Stage DOM lives in ui/stage/kc_template.js (shared with tools/harness)

// 既定は日本語。英語は localStorage 'stira.lang' = 'en' の時だけ
// The language picked on the Stage (its toggle stores it), else the dashboard's, else the browser's.
function pickLang() {
  try {
    const stored = localStorage.getItem('stira.lang')
    if (stored === 'en' || stored === 'ja') return stored
  } catch {
    /* storage refused */
  }
  const page = String(document.documentElement.lang || navigator.language || '').toLowerCase()
  return page.startsWith('ja') ? 'ja' : 'en'
}

// ja is always read (the fallback for a missing key); en only when it is the language
async function loadCatalog(base, lang) {
  const out = { ja: {}, en: {} }
  await Promise.all([...new Set(['ja', lang])].map(async (lang) => {
    try {
      const r = await fetch(`${base}i18n/catalog.${lang}.json`, { cache: 'no-cache' })
      if (r.ok) out[lang] = await r.json()
    } catch {
      /* keys are shown */
    }
  }))
  return out
}

// The static labels of the template (the shell did this in StiraCore). textContent only.
function applyLabels(root, catalog, lang) {
  const t = (k) => (catalog[lang] && catalog[lang][k]) || (catalog.ja && catalog.ja[k]) || null
  for (const n of root.querySelectorAll('[data-i18n]')) {
    const v = t(n.dataset.i18n)
    if (v) n.textContent = v
  }
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) {
    const v = t(n.dataset.i18nPlaceholder)
    if (v) n.setAttribute('placeholder', v)
  }
  for (const n of root.querySelectorAll('[data-i18n-aria-label]')) {
    const v = t(n.dataset.i18nAriaLabel)
    if (v) n.setAttribute('aria-label', v)
  }
}

// resolves once the sheet applies, so the Stage never lays out unstyled
function addCss(href) {
  const old = document.querySelector(`link[data-stira-css="${href}"]`)
  if (old) return Promise.resolve()
  return new Promise((resolve) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.dataset.stiraCss = href
    link.onload = () => resolve()
    link.onerror = () => resolve()
    document.head.append(link)
  })
}

// fetch (not run) the Stage's biggest modules while the rest loads
function preload(href) {
  if (document.querySelector(`link[rel="modulepreload"][href="${href}"]`)) return
  const link = document.createElement('link')
  link.rel = 'modulepreload'
  link.href = href
  document.head.append(link)
}

export default function StiraStage() {
  const api = useAppApi()
  const host = useRef(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const el = host.current
    if (!el) return undefined
    let alive = true
    const base = stageBase()
    // The app's scoped client, shaped like window.fetch: a refusal comes back as a Response
    // (the Stage reads status codes), anything else (network, abort) still throws.
    const apiFetch = async (url, init = {}) => {
      try {
        return await api.raw(url, init)
      } catch (err) {
        if (err && err.name === 'AppApiError' && typeof err.status === 'number') {
          return new Response(typeof err.body === 'string' ? err.body : '', { status: err.status, headers: { 'Content-Type': 'application/json' } })
        }
        throw err
      }
    }
    ;(async () => {
      // (main.js itself is imported with a per-mount query, so its deps are what is worth preloading)
      for (const m of ['vendor/three.stage.min.js', 'js/scene.js', 'js/talk.js', 'js/motion_catalog.js', 'js/hair_layer.js']) preload(`${base}${m}`)
      const root = document.createElement('div')
      root.id = 'stira-stage-root'
      root.className = 'stira-stage-root'
      const tplMod = await import(`${base}kc_template.js`)
      root.innerHTML = tplMod.TEMPLATE // constant markup, no interpolated data
      const lang = pickLang()
      // everything the Stage needs before it starts, in parallel
      const [catalog, , , , kc, confirm, hot, shelfMod, md, forestMod] = await Promise.all([
        loadCatalog(base, lang),
        addCss(`${base}stage.css`),
        addCss(`${base}stira-shell.css`),
        import(`${base}js/chat_core.js`),
        import(`${base}js/kc_core.js`),
        import(`${base}js/kc_confirm.js`),
        import(`${base}js/kc_hotspots.js`),
        import(`${base}js/kc_shelf.js`),
        import(`${base}js/markdown.js`),
        import(`${base}js/kc_forest.js`),
      ])
      if (!alive) return
      // the name plate: the agent you talk to here (KiroCrew's conductor), not StiraCore's persona
      for (const l of ['ja', 'en']) catalog[l]['stage.name'] = 'Kiro'
      applyLabels(root, catalog, lang)
      const data = document.createElement('script')
      data.type = 'application/json'
      data.id = 'i18n-catalog'
      data.textContent = JSON.stringify(catalog)
      root.append(data)
      el.replaceChildren(root)
      // chat_core.js runs once per page load; keep its own helpers as the base for every mount
      if (!globalThis.__stiraChatCoreBase) globalThis.__stiraChatCoreBase = globalThis.StiraChatCore
      window.StiraChatCore = kc.makeCore(globalThis.__stiraChatCoreBase, { fetch: apiFetch })
      window.stiraFetch = apiFetch
      window.StiraConfirm = confirm.makeConfirm(root)
      // Stage(main.js)はブラウザの言語を見るので、こちらで決めた言語を渡しておく
      try {
        localStorage.setItem('stira.lang', lang)
      } catch {
        /* storage refused */
      }
      mountSeq += 1
      await import(`${base}js/main.js?mount=${mountSeq}`)
      if (!alive) return
      const stageEl = root.querySelector('#stage')
      // 窓の外の森: 木を選んで「ボードで読む」と、その本だけをボードに出す
      const forest = forestMod.makeForest({
        root,
        stage: stageEl,
        apiFetch,
        lang,
        onRead: (book) => {
          if (root.stiraLive) root.stiraLive.ingestTurnEvent({ type: 'memory.recall', name: 'book', ms: 2800 })
          const text = shelfMod.bookMarkdown(book, lang)
          if (root.stiraBoard) root.stiraBoard.show({ key: `book-${book.id}-${Date.now()}`, text, c: md.classify(text) }, { explicit: true })
        },
      })
      const onPress = (id) => {
        if (id === 'shelf') {
          if (root.stiraLive) root.stiraLive.ingestTurnEvent({ type: 'memory.recall', name: 'shelf', ms: 3200 })
          void shelfMod.openShelfPicker({
            root,
            apiFetch,
            classify: md.classify,
            lang,
            onBook: () => root.stiraLive && root.stiraLive.ingestTurnEvent({ type: 'memory.recall', name: 'book', ms: 2800 }),
          })
          return true
        }
        if (id === 'window') {
          const w = root.querySelector('.kc-hotspot[data-spot="window"]')
          const from = w ? { left: w.offsetLeft, top: w.offsetTop, width: w.offsetWidth, height: w.offsetHeight } : null
          void forest.open(from)
          return true
        }
        return false
      }
      await hot.startHotspots({ root, stage: stageEl, base: `${base}assets`, lang, onPress })
      // 他のセッションの作業を部屋に映す(見えている間だけ、数秒おき)
      const watchMod = await import(`${base}js/kc_watch.js`)
      if (!alive) return
      watchMod.startWatch({
        root,
        lang,
        apiFetch,
        ownKey: () => (window.StiraChatCore && window.StiraChatCore.slotKey ? window.StiraChatCore.slotKey() : ''),
        emit: (ev) => root.stiraLive && root.stiraLive.ingestTurnEvent(ev),
      })
    })().catch((err) => {
      console.error('stira-kiro: stage failed to start', err)
      if (alive) setError(String((err && err.message) || err))
    })
    return () => {
      alive = false
      el.replaceChildren() // the Stage's loop and keys stop once its root is gone (main.js stageGone)
    }
  }, [])

  return h('div', { style: { position: 'relative', width: '100%', height: '100%', minHeight: 'calc(100vh - 64px)' } },
    h('div', { ref: host, style: { position: 'absolute', inset: 0 } }),
    error ? h('div', { style: { position: 'absolute', left: 16, top: 16, padding: 12, background: '#300', color: '#fcc', fontFamily: 'monospace', zIndex: 99 } }, 'Stage error: ' + error) : null,
  )
}
