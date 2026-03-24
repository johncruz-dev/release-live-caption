const POLL_MS_ACTIVE = 700
const POLL_MS_IDLE = 1300
const POLL_MS_ERROR = 1800
const IDLE_BACKOFF_AFTER = 3
const STABLE_MIN = 3
const MIN_WORDS  = 1
const READ_TIMEOUT_MS = 1800
const READY_CAPTION_RE = /ready to show live captions/i
const ENGLISH_CAPTION_RE = /live captions in english/i

let polling    = null
let timerTick  = null
let seconds    = 0
let paragraphs = new Map()
let paraCount  = 0
let bodyCache  = new Map()
let lastRaw     = ''
let stableCount = 0
let currentId   = null
let globalBase  = ''
let pollBusy    = false
let rafPending  = false
let sessionActive = false
let idleCycles = 0

// Selection guard via contenteditable
document.addEventListener('keydown', e => {
  const body = e.target.closest('.para-body')
  if (!body) return
  if (e.ctrlKey && (e.key === 'c' || e.key === 'a')) return
  e.preventDefault()
}, true)

document.addEventListener('paste', e => {
  if (e.target.closest('.para-body')) e.preventDefault()
}, true)

document.addEventListener('cut', e => {
  if (e.target.closest('.para-body')) e.preventDefault()
}, true)

// Block any selection that starts outside a para-body
document.addEventListener('selectstart', e => {
  if (!e.target.closest('.para-body')) e.preventDefault()
})
// End selection guard

window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => window.api.hideCaptionWindow(), 500)
})

async function startSession() {
  lastRaw = ''; stableCount = 0; currentId = null; globalBase = ''; idleCycles = 0
  seconds = 0; paragraphs = new Map(); bodyCache = new Map(); paraCount = 0
  sessionActive = true

  document.getElementById('recBadge').style.display   = 'flex'
  document.getElementById('btnStart').disabled        = true
  document.getElementById('btnStop').disabled         = false
  document.getElementById('transcript').innerHTML     = ''
  document.getElementById('transcript').style.display = 'none'
  document.getElementById('emptyState').style.display = 'flex'
  document.getElementById('btnExp').disabled          = true
  document.getElementById('btnCopyAll').disabled      = true

  await window.api.launchCaptions()

  void (async () => {
    for (let attempts = 0; attempts < 6 && sessionActive; attempts++) {
      const r = await window.api.hideCaptionWindow()
      if ((r || '').startsWith('hidden')) break
      await new Promise(resolve => setTimeout(resolve, 700))
    }
  })()

  startTimer()
  scheduleNextPoll(POLL_MS_ACTIVE)
}

function stopSession() {
  sessionActive = false
  clearTimeout(polling);   polling   = null
  clearInterval(timerTick); timerTick = null
  pollBusy   = false
  rafPending = false
  document.getElementById('btnStart').disabled = false
  document.getElementById('btnStop').disabled  = true
  if (currentId) finalisePara(currentId)
  currentId = null
  toast('Session ended', 'ok')
}

async function pollCaptions() {
  polling = null
  if (pollBusy) return
  pollBusy = true
  let nextDelay = POLL_MS_ACTIVE
  try {
    const raw = await withTimeout(window.api.readCaptionText(), READ_TIMEOUT_MS, 'TIMEOUT')

    if (raw === '__SAME__') {
      stableCount++
      idleCycles++
      nextDelay = idleCycles >= IDLE_BACKOFF_AFTER ? POLL_MS_IDLE : POLL_MS_ACTIVE
    } else if (
      !raw ||
      raw === 'NOT_FOUND' ||
      raw === 'WINDOW_FOUND_NO_TEXT' ||
      raw === 'TIMEOUT' ||
      READY_CAPTION_RE.test(raw) ||
      ENGLISH_CAPTION_RE.test(raw)
    ) {
      idleCycles++
      nextDelay = idleCycles >= IDLE_BACKOFF_AFTER ? POLL_MS_IDLE : POLL_MS_ACTIVE
      return
    } else if (raw !== lastRaw) {
      lastRaw = raw
      stableCount = 0
      idleCycles = 0

      const fresh = extractNew(raw)

      if (fresh) {
        if (!currentId) openPara()
        appendWords(currentId, fresh)
      }
    } else {
      stableCount++
      idleCycles++
      nextDelay = idleCycles >= IDLE_BACKOFF_AFTER ? POLL_MS_IDLE : POLL_MS_ACTIVE
    }

    if (stableCount === STABLE_MIN) {
      stableCount = 0
      if (currentId) {
        finalisePara(currentId)
        globalBase = lastRaw
        currentId  = null
      }
    }
  } catch (e) {
    idleCycles++
    nextDelay = POLL_MS_ERROR
  } finally {
    pollBusy = false
    if (sessionActive) scheduleNextPoll(nextDelay)
  }
}

function scheduleNextPoll(delay) {
  if (!sessionActive) return
  clearTimeout(polling)
  polling = setTimeout(pollCaptions, delay)
}

function withTimeout(promise, timeoutMs, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), timeoutMs))
  ])
}

function stripBase(raw, base) {
  if (!base) return raw.trim()
  const r = raw.trim()
  const b = base.trim()
  if (!r) return null

  if (r.toLowerCase().startsWith(b.toLowerCase()))
    return r.slice(b.length).trim()

  const bW = b.toLowerCase().split(/\s+/)
  const rW = r.split(/\s+/)
  for (let n = Math.min(bW.length, rW.length); n >= 2; n--) {
    if (bW.slice(-n).join(' ') === rW.slice(0, n).map(w => w.toLowerCase()).join(' '))
      return rW.slice(n).join(' ')
  }

  return null
}

function extractNew(raw) {
  const afterGlobal = stripBase(raw, globalBase)

  if (afterGlobal !== null) {
    return afterGlobal
  }

  globalBase = ''
  return raw.trim()
}

function openPara() {
  paraCount++
  const id = paraCount
  const ts = new Date().toLocaleTimeString('en-GB', {
    hour12: false, hour: '2-digit', minute: '2-digit',
  })
  paragraphs.set(id, { id, startTime: ts, text: '' })
  currentId = id

  const el = document.createElement('div')
  el.className = 'para active'
  el.id = 'para-' + id
  el.innerHTML = `
    <div class="para-header">
      <span class="para-ts">${ts}</span>
      <span class="para-num">#${id}</span>
      <div class="para-icons">
        <button class="para-icon cp" title="Copy" onclick="copyPara(${id},this)">📋</button>
      </div>
    </div>
    <div class="para-body" id="body-${id}" contenteditable="true" spellcheck="false"></div>`

  bodyCache.set(id, el.querySelector('.para-body'))
  const t = document.getElementById('transcript')
  t.style.display = 'flex'
  document.getElementById('emptyState').style.display = 'none'
  t.appendChild(el)
  document.getElementById('btnExp').disabled     = false
  document.getElementById('btnCopyAll').disabled = false
}

function appendWords(id, fresh) {
  const bodyEl = bodyCache.get(id)
  if (!bodyEl) return
  const prev = bodyEl.dataset.prev || ''
  if (fresh === prev) return

  if (fresh.startsWith(prev) && prev.length > 0) {
    // Safe: just append the new suffix — existing text nodes untouched
    bodyEl.appendChild(document.createTextNode(fresh.slice(prev.length)))
    bodyEl.dataset.prev = fresh
  } else {
    // Full replacement needed — save and restore selection offsets
    const sel = window.getSelection()
    let savedStart = -1, savedEnd = -1

    if (sel.rangeCount > 0 && bodyEl.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      const range = sel.getRangeAt(0)
      // Walk text nodes to get absolute char offsets
      const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT)
      let node, offset = 0
      while (node = walker.nextNode()) {
        const len = node.textContent.length
        if (node === range.startContainer) savedStart = offset + range.startOffset
        if (node === range.endContainer)   savedEnd   = offset + range.endOffset
        offset += len
      }
    }

    bodyEl.textContent = fresh
    bodyEl.dataset.prev = fresh

    // Restore selection by absolute char offsets in the new text
    if (savedStart !== -1 && savedEnd !== -1) {
      try {
        const range = document.createRange()
        const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT)
        let node, offset = 0, startSet = false
        while (node = walker.nextNode()) {
          const len = node.textContent.length
          if (!startSet && offset + len >= savedStart) {
            range.setStart(node, Math.min(savedStart - offset, len))
            startSet = true
          }
          if (startSet && offset + len >= savedEnd) {
            range.setEnd(node, Math.min(savedEnd - offset, len))
            break
          }
          offset += len
        }
        sel.removeAllRanges()
        sel.addRange(range)
      } catch {}
    }
  }

  scrollBottom()
}

function finalisePara(id) {
  const bodyEl = bodyCache.get(id)
  const el     = document.getElementById('para-' + id)
  if (!bodyEl || !el) return
  const text = bodyEl.textContent.trim()
  if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) {
    el.remove()
    paragraphs.delete(id)
    bodyCache.delete(id)
    if (!paragraphs.size) showEmpty()
    return
  }
  el.classList.remove('active')
  const p = paragraphs.get(id)
  if (p) p.text = text
  scrollBottom()
}

function copyPara(id, btn) {
  const bodyEl = bodyCache.get(id)
  if (!bodyEl) return
  const text = bodyEl.textContent.trim()
  if (!text) return toast('Nothing to copy yet', 'warn')
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓'; btn.classList.add('done')
    const el = document.getElementById('para-' + id)
    if (el) {
      el.classList.add('flash')
      setTimeout(() => el.classList.remove('flash'), 600)
    }
    setTimeout(() => { btn.textContent = '📋'; btn.classList.remove('done') }, 1400)
    toast('Copied ✓', 'ok')
  }).catch(() => {
    const r = document.createRange()
    r.selectNodeContents(bodyEl)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(r)
    toast('Text selected — Ctrl+C to copy', 'warn')
  })
}

function copyAll() {
  if (!paragraphs.size) return toast('Nothing to copy', 'err')
  const lines = [...paragraphs.values()].map(p => {
    const el = bodyCache.get(p.id)
    return `[${p.startTime}] ${el ? el.textContent.trim() : p.text}`
  }).filter(l => l.trim()).join('\n\n')
  navigator.clipboard.writeText(lines).then(() => {
    toast(`Copied ${paragraphs.size} paragraphs ✓`, 'ok')
    document.querySelectorAll('.para').forEach((c, i) => {
      setTimeout(() => {
        c.classList.add('flash')
        setTimeout(() => c.classList.remove('flash'), 400)
      }, i * 40)
    })
  })
}

async function exportNow() {
  if (!paragraphs.size) return toast('Nothing to export', 'err')
  const title = document.getElementById('recTitle')?.textContent.trim() || 'Untitled recording'
  const lines = [...paragraphs.values()].map(p => {
    const el = bodyCache.get(p.id)
    return `[${p.startTime}]\n${el ? el.textContent.trim() : p.text}`
  }).join('\n\n')
  const full = `${title}\nExported: ${new Date().toLocaleString()}\n${'─'.repeat(50)}\n\n${lines}`
  const fp = await window.api.exportTranscript(full, title)
  toast('Saved: ' + fp.split('\\').pop(), 'ok')
}

function startTimer() {
  seconds = 0
  timerTick = setInterval(() => {
    seconds++
    const m = String(Math.floor(seconds / 60)).padStart(2, '0')
    const s = String(seconds % 60).padStart(2, '0')
    document.getElementById('recTimer').textContent = `${m}:${s}`
  }, 1000)
}

function showEmpty() {
  document.getElementById('transcript').style.display = 'none'
  document.getElementById('emptyState').style.display = 'flex'
}

function scrollBottom() {
  if (rafPending) return
  rafPending = true
  requestAnimationFrame(() => {
    const t = document.getElementById('transcript')
    if (t) {
      if (polling) {
        t.scrollTop = t.scrollHeight
      } else {
        const isAtBottom = t.scrollTop + t.clientHeight >= t.scrollHeight - 10
        if (isAtBottom) t.scrollTop = t.scrollHeight
      }
    }
    rafPending = false
  })
}

function toast(msg, type = '') {
  const el = document.getElementById('toast')
  el.textContent = msg
  el.className = 'toast show' + (type ? ' ' + type : '')
  clearTimeout(el._t)
  el._t = setTimeout(() => el.className = 'toast', 3000)
}
