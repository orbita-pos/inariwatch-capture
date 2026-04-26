/**
 * Zero-dep feedback widget. Renders a floating button + modal into the DOM,
 * collects user report, and returns the payload for the integration to send.
 *
 * Styles are inlined to avoid leaking into the host app's CSS namespace.
 * Every element gets a `data-inariwatch-feedback` attribute so users who
 * want to customize can target it via CSS.
 */

export interface WidgetOptions {
  /** Placement of the floating button. Default: "bottom-right". */
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left"
  /** Button label. Default: "Report a bug". */
  buttonLabel?: string
  /** Modal title. Default: "Report a bug". */
  title?: string
  /** Pre-fill email field if the host app knows the user. */
  userEmail?: string
  /** Accent color for the primary button. Default: InariWatch orange. */
  accentColor?: string
  /** Hide the floating button (useful if host app renders its own trigger). */
  hideButton?: boolean
}

export interface FeedbackPayload {
  description: string
  email: string
  /** Optional dataURL if the user chose to attach a screenshot. */
  screenshot?: string
  /** Page URL where feedback was captured. */
  url: string
  userAgent: string
  /** Viewport size at capture time — helps correlate layout bugs. */
  viewport: { width: number; height: number }
}

type Handler = (payload: FeedbackPayload) => void

const ATTR = "data-inariwatch-feedback"

let mounted = false
let cleanup: (() => void) | null = null

export function mountFeedbackWidget(options: WidgetOptions, onSubmit: Handler): () => void {
  if (mounted) return cleanup ?? (() => {})
  if (typeof document === "undefined") return () => {}

  mounted = true

  // Validate accent: only CSS color tokens we trust (hex, rgb/rgba, hsl/hsla,
  // or named colors). Blocks CSS injection from a malicious integrator config.
  const ACCENT_RE = /^(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\([\d.,%\s/]+\)|[a-zA-Z]{3,20})$/
  const accent = options.accentColor && ACCENT_RE.test(options.accentColor.trim())
    ? options.accentColor.trim()
    : "#f97316"

  // Whitelist position — anything else would produce broken CSS anyway.
  const ALLOWED_POSITIONS = ["bottom-right", "bottom-left", "top-right", "top-left"] as const
  const pos: (typeof ALLOWED_POSITIONS)[number] = options.position && (ALLOWED_POSITIONS as readonly string[]).includes(options.position)
    ? options.position
    : "bottom-right"
  const buttonLabel = options.buttonLabel ?? "Report a bug"
  const title = options.title ?? "Report a bug"

  const style = document.createElement("style")
  style.setAttribute(ATTR, "styles")
  style.textContent = widgetCss(accent, pos)
  document.head.appendChild(style)

  let button: HTMLButtonElement | null = null
  if (!options.hideButton) {
    button = document.createElement("button")
    button.setAttribute(ATTR, "button")
    button.type = "button"
    button.textContent = buttonLabel
    button.addEventListener("click", openModal)
    document.body.appendChild(button)
  }

  const modal = document.createElement("div")
  modal.setAttribute(ATTR, "modal")
  modal.setAttribute("aria-hidden", "true")
  modal.setAttribute("role", "dialog")
  modal.setAttribute("aria-modal", "true")
  modal.innerHTML = modalHtml(title, options.userEmail ?? "")
  document.body.appendChild(modal)

  const overlay = modal.querySelector<HTMLDivElement>(`[${ATTR}="overlay"]`)!
  const form = modal.querySelector<HTMLFormElement>(`[${ATTR}="form"]`)!
  const closeBtn = modal.querySelector<HTMLButtonElement>(`[${ATTR}="close"]`)!
  const cancelBtn = modal.querySelector<HTMLButtonElement>(`[${ATTR}="cancel"]`)!
  const screenshotBtn = modal.querySelector<HTMLButtonElement>(`[${ATTR}="screenshot-btn"]`)!
  const screenshotPreview = modal.querySelector<HTMLDivElement>(`[${ATTR}="screenshot-preview"]`)!
  const statusEl = modal.querySelector<HTMLDivElement>(`[${ATTR}="status"]`)!
  const submitBtn = modal.querySelector<HTMLButtonElement>(`[${ATTR}="submit"]`)!

  let screenshotDataUrl: string | null = null

  overlay.addEventListener("click", closeModal)
  closeBtn.addEventListener("click", closeModal)
  cancelBtn.addEventListener("click", closeModal)
  screenshotBtn.addEventListener("click", () => void takeScreenshot())
  form.addEventListener("submit", (e) => {
    e.preventDefault()
    submitFeedback()
  })

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && modal.getAttribute("aria-hidden") === "false") closeModal()
  }
  document.addEventListener("keydown", onKey)

  function openModal() {
    modal.setAttribute("aria-hidden", "false")
    ;(modal.querySelector<HTMLTextAreaElement>("textarea"))?.focus()
  }

  function closeModal() {
    modal.setAttribute("aria-hidden", "true")
    statusEl.textContent = ""
    screenshotDataUrl = null
    screenshotPreview.innerHTML = ""
    screenshotPreview.style.display = "none"
    form.reset()
  }

  async function takeScreenshot() {
    // Native Screen Capture API — supported everywhere since Chrome 72+, FF 66+.
    // Avoids a 50 KB html2canvas dep. User has to approve a browser dialog
    // and select the tab — consent built in, zero risk of silent capture.
    statusEl.textContent = "Taking screenshot…"
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const track = stream.getVideoTracks()[0]
      // ImageCapture's `grabFrame` returns an ImageBitmap but different TS
      // lib.dom versions disagree on the exact shape — escape through
      // `unknown` to stay compatible across TS 4.x and 5.x.
      type ImageCaptureLike = new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> }
      const ImageCaptureCtor = (
        typeof window !== "undefined"
          ? ((window as unknown) as { ImageCapture?: ImageCaptureLike }).ImageCapture
          : undefined
      )
      let bitmap: ImageBitmap
      if (ImageCaptureCtor) {
        const capture = new ImageCaptureCtor(track)
        bitmap = await capture.grabFrame()
      } else {
        // Fallback: draw a video element to a canvas
        const video = document.createElement("video")
        video.srcObject = stream
        await video.play()
        bitmap = await createImageBitmap(video)
        video.pause()
      }
      track.stop()

      const canvas = document.createElement("canvas")
      // Downscale to max 1600px wide — keeps dataURL under ~500 KB
      const maxW = 1600
      const ratio = Math.min(1, maxW / bitmap.width)
      canvas.width = Math.round(bitmap.width * ratio)
      canvas.height = Math.round(bitmap.height * ratio)
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("Canvas 2D context unavailable")
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

      screenshotDataUrl = canvas.toDataURL("image/jpeg", 0.78)

      // Use createElement + src to avoid innerHTML with an interpolated string.
      // toDataURL always returns a safe base64 URL, but defense in depth is
      // cheap here.
      screenshotPreview.textContent = ""
      const img = document.createElement("img")
      img.alt = "Screenshot"
      img.src = screenshotDataUrl
      screenshotPreview.appendChild(img)
      screenshotPreview.style.display = "block"
      statusEl.textContent = ""
    } catch (err) {
      statusEl.textContent =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Screenshot canceled."
          : `Could not capture screen: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  function submitFeedback() {
    const description = (form.querySelector<HTMLTextAreaElement>("textarea")?.value ?? "").trim()
    const email = (form.querySelector<HTMLInputElement>("input[type='email']")?.value ?? "").trim()

    if (description.length < 3) {
      statusEl.textContent = "Please describe the issue (at least 3 characters)."
      return
    }

    submitBtn.disabled = true
    statusEl.textContent = "Sending…"

    try {
      onSubmit({
        description: description.slice(0, 5000),
        email: email.slice(0, 200),
        screenshot: screenshotDataUrl ?? undefined,
        url: location.href,
        userAgent: navigator.userAgent.slice(0, 300),
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
      statusEl.textContent = "Thanks — feedback sent!"
      setTimeout(closeModal, 900)
    } catch (err) {
      statusEl.textContent = `Failed to send: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      submitBtn.disabled = false
    }
  }

  cleanup = () => {
    document.removeEventListener("keydown", onKey)
    button?.remove()
    modal.remove()
    style.remove()
    mounted = false
    cleanup = null
  }

  return cleanup
}

// ── Styling ───────────────────────────────────────────────────────────────

function widgetCss(accent: string, position: string): string {
  const [v, h] = position.split("-") as ["top" | "bottom", "right" | "left"]
  const vAnchor = v === "top" ? "top: 20px;" : "bottom: 20px;"
  const hAnchor = h === "left" ? "left: 20px;" : "right: 20px;"

  return `
  [${ATTR}="button"] {
    all: initial;
    position: fixed; ${vAnchor} ${hAnchor}
    z-index: 2147483600;
    font: 500 13px system-ui, sans-serif;
    color: #fff;
    background: ${accent};
    padding: 10px 14px;
    border-radius: 8px;
    cursor: pointer;
    box-shadow: 0 4px 16px rgba(0,0,0,.16);
  }
  [${ATTR}="button"]:hover { opacity: .92; }

  [${ATTR}="modal"][aria-hidden="true"] { display: none; }
  [${ATTR}="modal"][aria-hidden="false"] {
    position: fixed; inset: 0;
    z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    font: 14px system-ui, sans-serif;
    color: #111;
  }
  [${ATTR}="overlay"] {
    position: absolute; inset: 0;
    background: rgba(0,0,0,.55);
  }
  [${ATTR}="panel"] {
    position: relative;
    width: min(480px, calc(100% - 32px));
    max-height: calc(100% - 32px);
    overflow: auto;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 20px 48px rgba(0,0,0,.3);
    padding: 20px 22px 18px;
  }
  [${ATTR}="header"] {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px;
  }
  [${ATTR}="header"] h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  [${ATTR}="close"] {
    all: initial;
    font: 500 14px system-ui, sans-serif;
    color: #777;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
  }
  [${ATTR}="close"]:hover { background: #f0f0f0; color: #111; }
  [${ATTR}="form"] label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #555;
    margin-top: 10px;
    margin-bottom: 4px;
  }
  [${ATTR}="form"] textarea,
  [${ATTR}="form"] input[type="email"] {
    width: 100%;
    box-sizing: border-box;
    font: 14px system-ui, sans-serif;
    padding: 8px 10px;
    border: 1px solid #d4d4d8;
    border-radius: 6px;
    background: #fff;
    color: #111;
  }
  [${ATTR}="form"] textarea {
    min-height: 80px;
    resize: vertical;
  }
  [${ATTR}="form"] textarea:focus,
  [${ATTR}="form"] input[type="email"]:focus {
    outline: none;
    border-color: ${accent};
    box-shadow: 0 0 0 2px ${accent}33;
  }
  [${ATTR}="screenshot-btn"] {
    all: initial;
    font: 500 12px system-ui, sans-serif;
    color: #555;
    background: #f4f4f5;
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    margin-top: 8px;
  }
  [${ATTR}="screenshot-btn"]:hover { background: #e4e4e7; color: #111; }
  [${ATTR}="screenshot-preview"] {
    display: none;
    margin-top: 10px;
    border: 1px solid #e4e4e7;
    border-radius: 6px;
    overflow: hidden;
  }
  [${ATTR}="screenshot-preview"] img {
    display: block;
    width: 100%;
    max-height: 200px;
    object-fit: cover;
  }
  [${ATTR}="actions"] {
    display: flex; align-items: center; justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }
  [${ATTR}="cancel"] {
    all: initial;
    font: 500 13px system-ui, sans-serif;
    color: #555;
    padding: 8px 14px;
    border-radius: 6px;
    cursor: pointer;
  }
  [${ATTR}="cancel"]:hover { background: #f0f0f0; color: #111; }
  [${ATTR}="submit"] {
    all: initial;
    font: 500 13px system-ui, sans-serif;
    color: #fff;
    background: ${accent};
    padding: 8px 14px;
    border-radius: 6px;
    cursor: pointer;
  }
  [${ATTR}="submit"]:hover { opacity: .92; }
  [${ATTR}="submit"][disabled] { opacity: .6; cursor: not-allowed; }
  [${ATTR}="status"] {
    flex: 1;
    font-size: 12px;
    color: #555;
  }
  @media (prefers-color-scheme: dark) {
    [${ATTR}="panel"] { background: #18181b; color: #fafafa; }
    [${ATTR}="header"] h2 { color: #fafafa; }
    [${ATTR}="close"] { color: #a1a1aa; }
    [${ATTR}="close"]:hover { background: #27272a; color: #fafafa; }
    [${ATTR}="form"] label { color: #a1a1aa; }
    [${ATTR}="form"] textarea,
    [${ATTR}="form"] input[type="email"] {
      background: #27272a; border-color: #3f3f46; color: #fafafa;
    }
    [${ATTR}="screenshot-btn"] { background: #27272a; color: #a1a1aa; }
    [${ATTR}="screenshot-btn"]:hover { background: #3f3f46; color: #fafafa; }
    [${ATTR}="cancel"] { color: #a1a1aa; }
    [${ATTR}="cancel"]:hover { background: #27272a; color: #fafafa; }
    [${ATTR}="status"] { color: #a1a1aa; }
  }
  `
}

function modalHtml(title: string, userEmail: string): string {
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
  return `
    <div ${ATTR}="overlay"></div>
    <div ${ATTR}="panel">
      <div ${ATTR}="header">
        <h2>${escape(title)}</h2>
        <button type="button" ${ATTR}="close" aria-label="Close">✕</button>
      </div>
      <form ${ATTR}="form" novalidate>
        <label for="iw-feedback-desc">What happened?</label>
        <textarea id="iw-feedback-desc" required maxlength="5000" placeholder="Describe the issue (what you were doing, what you expected, what you saw)"></textarea>

        <label for="iw-feedback-email">Your email (optional)</label>
        <input id="iw-feedback-email" type="email" maxlength="200" value="${escape(userEmail)}" placeholder="you@example.com" />

        <button type="button" ${ATTR}="screenshot-btn">📸 Attach screenshot</button>
        <div ${ATTR}="screenshot-preview"></div>

        <div ${ATTR}="actions">
          <div ${ATTR}="status" role="status" aria-live="polite"></div>
          <button type="button" ${ATTR}="cancel">Cancel</button>
          <button type="submit" ${ATTR}="submit">Send</button>
        </div>
      </form>
    </div>
  `
}
