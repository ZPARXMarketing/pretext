// Cursor Walk demo — a phantom cursor moves character-by-character through
// text whose line breaks were computed by Pretext and whose per-grapheme x
// positions were measured via canvas measureText (the same approach Pretext
// uses internally). No DOM reads occur in the animation hot path.

import { prepareWithSegments, layoutWithLines } from '../../src/layout.ts'

// ── Constants ────────────────────────────────────────────────────────────────

const FONT = '18px "Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif'
const LINE_HEIGHT = 30
const PARA_EXTRA_GAP = 20  // extra vertical gap between paragraphs (px)
const MAX_TEXT_WIDTH = 640
const SIDE_PAD = 48        // minimum left/right margin (px)
const DEFAULT_SPEED = 7    // maps to ~45ms per grapheme

const PARAGRAPHS = [
  'Every glyph is a measured promise.',

  "The browser's text engine knows where your words will land — but only after " +
  'it renders them. Each resize forces a reflow: the DOM is read, layout is ' +
  'computed, dimensions flow back to JavaScript. For a list of five hundred ' +
  'items, that is five hundred synchronous layout reads per frame.',

  'Pretext asks a different question. What if you measured the text once — not ' +
  'in the DOM, but on a canvas — and cached every segment width? Then layout ' +
  'becomes pure arithmetic. No DOM reads. No render-tree queries. Just numbers ' +
  'walking a cached array at resize time.',

  'This cursor knows exactly where it stands because the math was done before ' +
  'the first pixel was drawn. Canvas measureText. Intl.Segmenter word ' +
  'boundaries. Grapheme-level break opportunities. Emoji width correction. ' +
  'Browser-specific line-fit tolerances baked into the engine profile.',

  'Every character position you see was computed in advance. The cursor is not ' +
  'asking the browser where to go. It already knows. That is what text layout ' +
  'feels like when the engine has done the work.',
]

// ── Types ─────────────────────────────────────────────────────────────────────

type LineEntry = {
  text: string
  graphemes: string[]
  // xPositions[i] = pixel offset from line's left edge before grapheme i.
  // xPositions[graphemes.length] = width after the last grapheme.
  xPositions: number[]
  y: number       // top offset in the stage (px)
  offsetX: number // left offset in the stage (px) — cached for render speed
  el: HTMLDivElement
  litEl: HTMLSpanElement
  dimEl: HTMLSpanElement
}

// ── Measurement helpers ───────────────────────────────────────────────────────

// Reuse a single OffscreenCanvas and Segmenter across all measurements so we
// don't create hundreds of objects during buildLayout.
const measureCanvas = new OffscreenCanvas(1, 1)
const measureCtx = measureCanvas.getContext('2d')!
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Returns per-grapheme x positions by measuring cumulative prefix widths, which
// accounts for kerning just as a browser rendering engine would.
function measureXPositions(text: string): { graphemes: string[]; xPositions: number[] } {
  measureCtx.font = FONT
  const graphemes: string[] = []
  const xPositions: number[] = [0]
  let prefix = ''
  for (const { segment } of graphemeSegmenter.segment(text)) {
    graphemes.push(segment)
    prefix += segment
    xPositions.push(measureCtx.measureText(prefix).width)
  }
  return { graphemes, xPositions }
}

// ── State ─────────────────────────────────────────────────────────────────────

let lines: LineEntry[] = []
let totalGraphemes = 0

// currentFlat: number of graphemes that have been revealed so far.
// 0 = nothing shown yet; totalGraphemes = everything revealed.
let currentFlat = 0

let msPerGrapheme = sliderToMs(DEFAULT_SPEED)
let isPaused = false
let rafId: number | null = null
let lastTime = 0  // performance.now() timestamp of last advance; 0 = not started

// ── DOM refs ──────────────────────────────────────────────────────────────────

const stage = document.getElementById('stage') as HTMLDivElement
const cursorDiv = document.getElementById('cursor') as HTMLDivElement
const infoLineEl = document.getElementById('info-line') as HTMLSpanElement
const infoCharEl = document.getElementById('info-char') as HTMLSpanElement
const speedSlider = document.getElementById('speed-slider') as HTMLInputElement
const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement
const restartBtn = document.getElementById('restart-btn') as HTMLButtonElement

// ── Layout ────────────────────────────────────────────────────────────────────

function buildLayout(): void {
  const stageWidth = stage.clientWidth
  const textWidth = Math.min(stageWidth - SIDE_PAD * 2, MAX_TEXT_WIDTH)
  const offsetX = Math.round((stageWidth - textWidth) / 2)

  // Remove all children except the cursor div.
  for (const child of [...stage.children]) {
    if (child !== cursorDiv) child.remove()
  }

  lines = []
  totalGraphemes = 0
  let y = 0

  for (let pi = 0; pi < PARAGRAPHS.length; pi++) {
    if (pi > 0) y += PARA_EXTRA_GAP

    const para = PARAGRAPHS[pi]!

    // Use Pretext to compute line breaks for this paragraph.
    const prepared = prepareWithSegments(para, FONT)
    const { lines: paraLines } = layoutWithLines(prepared, textWidth, LINE_HEIGHT)

    for (const pLine of paraLines) {
      const lineDiv = document.createElement('div')
      lineDiv.className = 'text-line'
      lineDiv.style.top = `${y}px`
      lineDiv.style.left = `${offsetX}px`
      lineDiv.style.width = `${textWidth}px`

      const litSpan = document.createElement('span')
      litSpan.className = 'lit'

      const dimSpan = document.createElement('span')
      dimSpan.className = 'dim'
      dimSpan.textContent = pLine.text

      lineDiv.append(litSpan, dimSpan)
      // Insert before cursor so cursor stays the last child (on top).
      stage.insertBefore(lineDiv, cursorDiv)

      // Measure per-grapheme x positions via canvas — the same technique
      // Pretext uses for segment widths.
      const { graphemes, xPositions } = measureXPositions(pLine.text)

      lines.push({
        text: pLine.text,
        graphemes,
        xPositions,
        y,
        offsetX,
        el: lineDiv,
        litEl: litSpan,
        dimEl: dimSpan,
      })

      totalGraphemes += graphemes.length
      y += LINE_HEIGHT
    }
  }

  stage.style.height = `${y + 64}px`
}

// ── Coordinate mapping ────────────────────────────────────────────────────────

// Maps a flat grapheme index to (lineIndex, graphemeIndex-within-line).
// gi is the count of graphemes already revealed on line li.
function flatToPos(flat: number): { li: number; gi: number } {
  let rem = flat
  for (let li = 0; li < lines.length; li++) {
    const n = lines[li]!.graphemes.length
    if (rem <= n) return { li, gi: rem }
    rem -= n
  }
  const last = lines.length - 1
  return { li: last, gi: lines[last]!.graphemes.length }
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(li: number, gi: number): void {
  // Update each line's lit/dim split.
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!
    if (i < li) {
      // Fully revealed lines.
      ln.litEl.textContent = ln.text
      ln.dimEl.textContent = ''
    } else if (i === li) {
      // Active line: split at gi.
      ln.litEl.textContent = ln.graphemes.slice(0, gi).join('')
      ln.dimEl.textContent = ln.graphemes.slice(gi).join('')
    } else {
      // Not yet reached.
      ln.litEl.textContent = ''
      ln.dimEl.textContent = ln.text
    }
  }

  // Position the cursor using the pre-computed x offset.
  const ln = lines[li]!
  const x = ln.offsetX + (ln.xPositions[gi] ?? 0)
  cursorDiv.style.left = `${x}px`
  cursorDiv.style.top = `${ln.y}px`

  // Update the HUD.
  infoLineEl.textContent = String(li + 1)
  infoCharEl.textContent = String(gi)
}

// ── Animation loop ────────────────────────────────────────────────────────────

function animate(now: number): void {
  if (!isPaused) {
    if (lastTime === 0) lastTime = now
    const steps = Math.floor((now - lastTime) / msPerGrapheme)
    if (steps > 0) {
      lastTime += steps * msPerGrapheme
      currentFlat = Math.min(currentFlat + steps, totalGraphemes)
    }
  }

  const { li, gi } = flatToPos(currentFlat)
  render(li, gi)

  if (currentFlat < totalGraphemes) {
    rafId = requestAnimationFrame(animate)
  } else {
    rafId = null
    // Fade out and blink the cursor once all text is revealed.
    cursorDiv.classList.add('blinking')
  }
}

// ── Playback control ──────────────────────────────────────────────────────────

function startAnimation(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  currentFlat = 0
  isPaused = false
  lastTime = 0
  pauseBtn.textContent = 'Pause'
  cursorDiv.style.opacity = '1'
  cursorDiv.classList.remove('blinking')

  // Snap cursor to line 0 position 0 before the first frame.
  if (lines.length > 0) {
    cursorDiv.style.top = `${lines[0]!.y}px`
    cursorDiv.style.left = `${lines[0]!.offsetX}px`
  }

  rafId = requestAnimationFrame(animate)
}

function sliderToMs(val: number): number {
  // val 1..10 → ~140ms..8ms per grapheme (exponential feel)
  return Math.round(8 + (10 - val) * (10 - val) * 1.35)
}

// ── Events ────────────────────────────────────────────────────────────────────

speedSlider.value = String(DEFAULT_SPEED)
speedSlider.addEventListener('input', () => {
  msPerGrapheme = sliderToMs(Number.parseInt(speedSlider.value, 10))
})

pauseBtn.addEventListener('click', () => {
  if (currentFlat >= totalGraphemes) return
  isPaused = !isPaused
  pauseBtn.textContent = isPaused ? 'Resume' : 'Pause'
  if (!isPaused) {
    // Reset timer so we don't leap forward after the pause gap.
    lastTime = 0
    if (rafId === null) rafId = requestAnimationFrame(animate)
  }
})

restartBtn.addEventListener('click', () => {
  // Reset all line content to dim before restarting.
  for (const ln of lines) {
    ln.litEl.textContent = ''
    ln.dimEl.textContent = ln.text
  }
  startAnimation()
})

// Rebuild on resize (debounced), preserving proportional progress.
let resizeTimer: ReturnType<typeof setTimeout> | null = null
window.addEventListener('resize', () => {
  if (resizeTimer !== null) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    resizeTimer = null
    const prevFlat = currentFlat
    const prevTotal = totalGraphemes

    buildLayout()

    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }

    // Keep proportional progress through the text after reflow.
    currentFlat = prevTotal > 0
      ? Math.round((prevFlat / prevTotal) * totalGraphemes)
      : 0

    if (currentFlat < totalGraphemes) {
      lastTime = 0
      if (!isPaused) rafId = requestAnimationFrame(animate)
      else {
        const { li, gi } = flatToPos(currentFlat)
        render(li, gi)
      }
    } else {
      const { li, gi } = flatToPos(totalGraphemes)
      render(li, gi)
      cursorDiv.classList.add('blinking')
    }
  }, 120)
})

// ── Boot ──────────────────────────────────────────────────────────────────────

document.fonts.ready.then(() => {
  buildLayout()
  startAnimation()
})
