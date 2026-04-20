/**
 * Phase 3: Click Easy Apply button — locate and click the Easy Apply button
 * using CDP (trusted events) with a content-script synthetic-click fallback,
 * including SDUI <a> tag handling.
 */

import { getActiveLinkedInTabId, sendCommand } from '../bridge'
import { applyTrace } from '../apply-trace'
import { appLog } from '../app-log'
import {
  easyApplyBridgeCommand
} from './shared'
import type { EasyApplyResult } from './shared'

// ────────────────────────────────────────────────────────────────────────────
// Bezier mouse path generation for CDP (Chrome DevTools Protocol) clicks.
// Humans move cursors in arcs with overshoot — straight-line moves are a bot tell.
// Sources: ResearchGate 393981520, GitHub sarperavci/human_mouse
// ────────────────────────────────────────────────────────────────────────────

function bezierVal(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

function generateCdpMousePath(
  x0: number, y0: number, x1: number, y1: number
): Array<{ x: number; y: number }> {
  const dx = x1 - x0, dy = y1 - y0
  const dist = Math.sqrt(dx * dx + dy * dy)
  const arcMag = dist * (0.08 + Math.random() * 0.2)
  const perpX = -dy / (dist || 1), perpY = dx / (dist || 1)
  const sign = Math.random() > 0.5 ? 1 : -1

  const cp1x = x0 + dx * 0.3 + perpX * arcMag * sign * (0.5 + Math.random() * 0.5)
  const cp1y = y0 + dy * 0.3 + perpY * arcMag * sign * (0.5 + Math.random() * 0.5)
  const cp2x = x0 + dx * 0.7 + perpX * arcMag * sign * (0.2 + Math.random() * 0.4)
  const cp2y = y0 + dy * 0.7 + perpY * arcMag * sign * (0.2 + Math.random() * 0.4)

  const steps = Math.max(6, Math.min(18, Math.round(dist / 25)))
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    // Ease in/out (Fitts's Law acceleration)
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    pts.push({
      x: Math.round(bezierVal(e, x0, cp1x, cp2x, x1) + (Math.random() - 0.5) * 1.5),
      y: Math.round(bezierVal(e, y0, cp1y, cp2y, y1) + (Math.random() - 0.5) * 1.5)
    })
  }
  // Overshoot on longer moves (~70% probability, 3-12% of distance)
  if (dist > 40 && Math.random() < 0.7) {
    const osPct = 0.03 + Math.random() * 0.09
    pts.push({ x: Math.round(x1 + dx * osPct), y: Math.round(y1 + dy * osPct) })
    // Corrective sub-movement
    pts.push({ x: Math.round(x1 + (Math.random() - 0.5) * 3), y: Math.round(y1 + (Math.random() - 0.5) * 3) })
  }
  return pts
}

/** Result of the click-apply phase. */
export type EasyApplyClickResult = {
  earlyExit: EasyApplyResult | null
  clickResult: { ok: boolean; detail: string; data?: unknown } | EasyApplyResult | null
  sduiApplyUrl: string | undefined
  cdpClickSucceeded: boolean
}

type BridgeCmdResult = Awaited<ReturnType<typeof easyApplyBridgeCommand>>

/**
 * Use CDP Runtime.evaluate to find the Easy Apply button directly in the tab,
 * bypassing the content script entirely. This works even when the content script
 * is stale because it runs fresh JS in the page context via the debugger.
 * Polls up to 10 seconds for the button to appear (detail panel may load async).
 */
async function cdpLocateEasyApplyButton(tabId: number, targetJobId?: string): Promise<{
  ok: boolean; x: number; y: number; width?: number; height?: number; tag: string; cls?: string; text?: string;
  sduiApplyUrl?: string; detail?: string; diag?: Record<string, unknown>
} | null> {
  // Inject the target job ID directly — don't rely on URL which LinkedIn SPA may rewrite.
  const jobIdLiteral = targetJobId ? `'${targetJobId}'` : 'null'
  const locateExpr = `(async () => {
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    const buttonSels = 'button.jobs-apply-button, button[aria-label*="Easy Apply" i]';
    const anchorSels = 'a.jobs-apply-button, a[aria-label*="Easy Apply" i]';
    const targetJobId = ${jobIdLiteral};

    function findBtn() {
      const roots = [document];
      const sduiHost = document.querySelector('#interop-outlet');
      if (sduiHost && sduiHost.shadowRoot) roots.push(sduiHost.shadowRoot);
      const candidates = [];
      for (const root of roots) {
        candidates.push(...root.querySelectorAll(buttonSels));
        candidates.push(...root.querySelectorAll(anchorSels));
      }
      let foundApplied = false;
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.top < 100) continue; // Skip header/nav/filter-bar elements
        if (el.getAttribute('role') === 'radio') continue;
        if (el.classList && el.classList.contains('artdeco-pill')) continue;
        const text = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        if (text.includes('applied')) { foundApplied = true; continue; }
        if (text.includes('easy apply')) {
          const isSDUI = el.tagName === 'A' && el.href && el.href.includes('openSDUIApplyFlow');
          el.scrollIntoView({ block: 'center' });
          const rect = el.getBoundingClientRect();
          return {
            ok: true, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2),
            width: Math.round(rect.width), height: Math.round(rect.height),
            tag: el.tagName, isSDUI,
            cls: (el.className || '').substring(0, 80),
            text: (el.textContent || '').trim().substring(0, 60),
            sduiApplyUrl: isSDUI ? el.href : undefined,
            el
          };
        }
      }
      if (foundApplied) return { ok: false, detail: 'already_applied' };
      return null;
    }

    // Phase 1: Poll for the button — locate only, no click
    for (let poll = 0; poll < 5; poll++) {
      if (poll > 0) await sleep(600);
      const btn = findBtn();
      if (btn && btn.ok) {
        const { el, ...rest } = btn;
        return JSON.stringify(rest);
      }
      if (btn && !btn.ok) return JSON.stringify({ ok: btn.ok, detail: btn.detail });
    }

    // Phase 2: On search results — try clicking the target job card
    let clickedCard = false;
    if (targetJobId) {
      const links = document.querySelectorAll('a[href*="/jobs/view/' + targetJobId + '"]');
      for (const link of links) {
        const r = link.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top > 100) {
          link.click();
          clickedCard = true;
          break;
        }
      }
      if (!clickedCard) {
        const listEl = document.querySelector('.jobs-search-results-list, .scaffold-layout__list');
        if (listEl) {
          listEl.scrollTop += 600;
          await sleep(1000);
          const links2 = document.querySelectorAll('a[href*="/jobs/view/' + targetJobId + '"]');
          for (const link of links2) {
            const r = link.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              link.click();
              clickedCard = true;
              break;
            }
          }
        }
      }
    }

    if (clickedCard) {
      await sleep(2500);
      for (let poll = 0; poll < 10; poll++) {
        if (poll > 0) await sleep(800);
        const btn = findBtn();
        if (btn && btn.ok) {
          const { el, ...rest } = btn;
          return JSON.stringify(rest);
        }
        if (btn && !btn.ok) return JSON.stringify({ ok: btn.ok, detail: btn.detail });
      }
    }

    // Diagnostic
    const bodyText = (document.body.textContent || '').toLowerCase();
    const diag = {
      url: location.href, targetJobId, clickedCard,
      hasEasyApplyText: bodyText.includes('easy apply'),
      hasAppliedBadge: bodyText.includes('applied'),
      detailPanelFound: !!document.querySelector('.jobs-search__job-details, .job-details-module, .jobs-details')
    };
    return JSON.stringify({ ok: false, detail: 'easy_apply_button_not_found', diag });
  })()`

  // Retry up to 2 times — the SPA may navigate mid-evaluate ("target navigated
  // or closed"), especially right after the page loads from the navigate phase.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const attachRes = await sendCommand('CDP_ATTACH', { tabId }, 10_000)
      if (!attachRes.ok) {
        appLog.info('[easy-apply] CDP locate: attach failed', { detail: attachRes.detail })
        return null
      }
      // Wait for SPA to settle after attach — LinkedIn's SPA router may still
      // be processing the currentJobId parameter, causing a navigation event.
      await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 4000))
      try {
        const result = await sendCommand('CDP_COMMAND', {
          tabId,
          method: 'Runtime.evaluate',
          params: { expression: locateExpr, returnByValue: true, awaitPromise: true }
        }, 25_000)
        // CDP_COMMAND result shape: { ok, detail, data: { result: { result: { type, value } } } }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cdpValue = (result as any)?.data?.result?.result?.value
        const parsed = typeof cdpValue === 'string' ? JSON.parse(cdpValue) : null
        if (!parsed) {
          const detail = String((result as any)?.detail || '')
          // "target navigated or closed" → SPA route change, retry
          if (attempt < 1 && detail.includes('navigated or closed')) {
            appLog.info('[easy-apply] CDP locate: target navigated, retrying...', { attempt })
            try { await sendCommand('CDP_DETACH', { tabId }, 5_000) } catch { /* best effort */ }
            continue
          }
          appLog.info('[easy-apply] CDP locate: no parseable result', {
            ok: result.ok, detail: detail.slice(0, 200),
            dataKeys: Object.keys((result as any)?.data || {})
          })
          return null
        }
        return parsed
      } finally {
        try { await sendCommand('CDP_DETACH', { tabId }, 5_000) } catch { /* best effort */ }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt < 1 && msg.includes('navigated')) {
        appLog.info('[easy-apply] CDP locate: target navigated exception, retrying...', { attempt })
        continue
      }
      appLog.warn('[easy-apply] CDP locate failed:', msg)
      return null
    }
  }
  return null
}

async function attemptCdpClick(
  bx: number, by: number, tag: unknown, tabId: number
): Promise<{ succeeded: boolean; clickResult: BridgeCmdResult | null }> {
  try {
    appLog.info('[easy-apply] CDP click: attaching to tab', { tabId, x: bx, y: by, tag })
    applyTrace('easy_apply:cdp_click_attempt', { tabId, x: bx, y: by, tag })
    const attachRes = await sendCommand('CDP_ATTACH', { tabId }, 10_000)
    if (!attachRes.ok) return { succeeded: false, clickResult: null }

    await new Promise((r) => setTimeout(r, 300 + Math.random() * 400))
    // Use CDP-provided coordinates directly — the stale content script's
    // LOCATE_EASY_APPLY_BUTTON matches the filter pill, not the real button.
    const cx = bx, cy = by

    // Bezier mouse approach — simulate human cursor movement arc
    const startX = cx + (Math.random() - 0.5) * 300
    const startY = cy - 100 - Math.random() * 200
    const mousePath = generateCdpMousePath(startX, startY, cx, cy)
    for (let mi = 0; mi < mousePath.length; mi++) {
      const pt = mousePath[mi]
      await sendCommand('CDP_COMMAND', { tabId, method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 } }, 5_000)
      // Fitts's Law speed: slower at start/end, faster in middle
      const progress = mi / mousePath.length
      const moveDelay = progress < 0.2 || progress > 0.8
        ? 20 + Math.random() * 30
        : 8 + Math.random() * 18
      await new Promise((r) => setTimeout(r, moveDelay))
    }
    // Hover dwell before click (150-400ms)
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 250))
    // buttons bitmask: 1=left pressed. Chrome MCP includes this and LinkedIn
    // checks event.buttons — omitting it produces buttons:0 during mousePressed.
    await sendCommand('CDP_COMMAND', { tabId, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 } }, 5_000)
    // Human press-to-release: 60-180ms
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 120))
    await sendCommand('CDP_COMMAND', { tabId, method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 } }, 5_000)

    appLog.info('[easy-apply] CDP click dispatched — waiting for modal')
    applyTrace('easy_apply:cdp_click_dispatched', { x: cx, y: cy, originalY: by })
    await new Promise((r) => setTimeout(r, 5000))

    // Verify the click actually opened a modal — CDP command success ≠ modal open
    const checkExpr = `JSON.stringify({
      url: location.href,
      hasModal: !!document.querySelector('.jobs-easy-apply-modal'),
      hasArtdecoModal: !!document.querySelector('.artdeco-modal[role="dialog"]'),
      inputCount: document.querySelectorAll('.artdeco-modal input:not([type="hidden"]), .artdeco-modal select, .artdeco-modal textarea, .jobs-easy-apply-modal input:not([type="hidden"]), .jobs-easy-apply-modal select, .jobs-easy-apply-modal textarea').length
    })`
    let checkParsed: { url?: string; hasModal?: boolean; hasArtdecoModal?: boolean; inputCount?: number } | null = null
    try {
      const checkRes = await sendCommand('CDP_COMMAND', {
        tabId,
        method: 'Runtime.evaluate',
        params: { expression: checkExpr, returnByValue: true }
      }, 10_000)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const checkVal = (checkRes as any)?.data?.result?.result?.value
      checkParsed = checkVal ? JSON.parse(checkVal) : null
    } catch (checkErr) {
      appLog.warn('[easy-apply] CDP post-click state check failed:', checkErr instanceof Error ? checkErr.message : String(checkErr))
    }

    try { await sendCommand('CDP_DETACH', { tabId }, 5_000) } catch (err) { appLog.warn('[easy-apply] CDP detach after click failed (best-effort):', err instanceof Error ? err.message : String(err)) }
    await new Promise((r) => setTimeout(r, 1500))

    const modalDetected = !!(checkParsed?.hasModal || checkParsed?.hasArtdecoModal || (checkParsed?.inputCount ?? 0) > 0)
    appLog.info('[easy-apply] CDP click post-check', { modalDetected, ...checkParsed })
    return {
      succeeded: modalDetected,
      clickResult: {
        ok: modalDetected,
        detail: modalDetected ? 'clicked_easy_apply_cdp_modal_open' : 'clicked_easy_apply_cdp_no_modal',
        data: checkParsed
      }
    }
  } catch (cdpErr) {
    appLog.info('[easy-apply] CDP click failed, falling back to synthetic', { error: cdpErr instanceof Error ? cdpErr.message : String(cdpErr) })
    applyTrace('easy_apply:cdp_click_failed', { error: String(cdpErr) })
    try { await sendCommand('CDP_DETACH', { tabId }, 5_000) } catch (err) { appLog.warn('[easy-apply] CDP detach cleanup failed:', err instanceof Error ? err.message : String(err)) }
    return { succeeded: false, clickResult: null }
  }
}

async function checkFormAlreadyOpen(): Promise<{ formOpen: boolean; fieldCount: number; failDetail?: string }> {
  const modalCheck = await easyApplyBridgeCommand('EXTRACT_FORM_FIELDS', {}, 'click_apply', 'modal_already_open_check')
  const modalCheckData = (modalCheck as { data?: unknown }).data
  const modalFields = Array.isArray(modalCheckData) ? modalCheckData as Array<Record<string, unknown>> : []
  const realFields = modalFields.filter(f => {
    const label = String(f.label || '').toLowerCase()
    return label && !label.includes('search message') && !label.includes('compose message') && label !== 'search'
  })
  if (modalCheck.ok && realFields.length >= 2) {
    appLog.info('[easy-apply] Easy Apply button not found, but form is already open — skipping click', { fieldCount: realFields.length })
    applyTrace('easy_apply:form_already_open', { fieldsInCheck: realFields.length })
    return { formOpen: true, fieldCount: realFields.length }
  }
  return { formOpen: false, fieldCount: 0, failDetail: `modalCheckFields:${modalFields.length},realFields:${realFields.length}` }
}

function numericDiagValue(diagData: Record<string, unknown>, key: string): number {
  const n = Number(diagData[key])
  return Number.isFinite(n) ? n : 0
}

/**
 * Detect a common SDUI failure mode where /apply redirects back to /jobs/view
 * and no Easy Apply surface exists. In this state, long modal polling never
 * succeeds, so we should fail fast and let the runner skip the listing.
 */
function diagnosticSuggestsNonApplyLanding(diagData: Record<string, unknown>): boolean {
  const url = String(diagData.url || '').toLowerCase()
  const landedBackOnJobView = url.includes('/linkedin.com/jobs/view/') || /linkedin\.com\/jobs\/view\//i.test(url)
  if (!landedBackOnJobView) return false

  const stillOnApplyUrl = url.includes('/apply/') || url.includes('opensduiapplyflow=true')
  if (stillOnApplyUrl) return false

  const hasModalRoot = !!diagData.modalRootFound
  const hasInteropOutlet = !!diagData.hasInteropOutlet
  const modalCount =
    numericDiagValue(diagData, 'easyApplyModals') +
    numericDiagValue(diagData, 'roleDialogs') +
    numericDiagValue(diagData, 'artdecoModals')
  const sduiFieldCount = numericDiagValue(diagData, 'sduiFormFieldCount')
  return !hasModalRoot && !hasInteropOutlet && modalCount === 0 && sduiFieldCount === 0
}

async function handleSduiNavigation(
  sduiUrl: string, cdpClickSucceeded: boolean, clickDetail: string
): Promise<boolean> {
  const pollForModal = async (
    attempts: number,
    delayMs: number,
    blockStage: string
  ): Promise<boolean> => {
    for (let poll = 0; poll < attempts; poll++) {
      await new Promise((r) => setTimeout(r, delayMs))
      try {
        const probe = await easyApplyBridgeCommand('EXTRACT_FORM_FIELDS', {}, 'navigate', blockStage)
        const pollData = (probe as { data?: unknown }).data
        const probeFields = Array.isArray(pollData) ? pollData as Array<Record<string, unknown>> : []
        appLog.info('[easy-apply] Modal poll', { blockStage, attempt: poll + 1, ok: probe.ok, fields: probeFields.length })
        if (probe.ok && probeFields.length > 0) {
          appLog.info('[easy-apply] Modal found after navigate', { blockStage, fields: probeFields.length })
          return true
        }
      } catch (err) {
        appLog.warn('[easy-apply] Modal poll extract failed (bridge settling):', err instanceof Error ? err.message : String(err))
      }
    }
    return false
  }

  const sduiModalAlreadyOpened = clickDetail === 'clicked_sdui_modal_opened' ||
    clickDetail === 'clicked_sdui_form_appeared' ||
    clickDetail === 'clicked_sdui_discarded_draft'
  if (sduiModalAlreadyOpened) {
    appLog.info('[easy-apply] SDUI modal opened by content script el.click() — skipping FORCE_NAVIGATE', { detail: clickDetail })
    applyTrace('easy_apply:sdui_modal_opened_by_click', { detail: clickDetail })
    return true
  }

  if (cdpClickSucceeded) {
    const probe = await easyApplyBridgeCommand('EXTRACT_FORM_FIELDS', {}, 'click_apply', 'post_cdp_modal_check')
    const probeData = (probe as { data?: unknown }).data
    const probeFields = Array.isArray(probeData) ? probeData as Array<Record<string, unknown>> : []
    if (probe.ok && probeFields.length > 0) {
      appLog.info('[easy-apply] Modal already open after CDP click — skipping FORCE_NAVIGATE', { fields: probeFields.length })
      applyTrace('easy_apply:sdui_modal_opened_by_cdp', { fields: probeFields.length })
      return true
    }
  }

  appLog.info('[easy-apply] SDUI link — force-navigating to apply URL', { sduiUrl })
  applyTrace('easy_apply:sdui_force_navigate', { sduiApplyUrl: sduiUrl })
  try {
    const forceNav = await easyApplyBridgeCommand('FORCE_NAVIGATE', { url: sduiUrl }, 'navigate', 'sdui_force_navigate')
    if (!forceNav.ok) return false

    appLog.info('[easy-apply] FORCE_NAVIGATE sent — waiting for bridge reconnection...')
    const { bridgeEvents } = await import('../bridge')
    const bridgeReady = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => { resolve(false) }, 20_000)
      bridgeEvents.once('bridge-ready', () => { clearTimeout(timeout); resolve(true) })
    })
    if (!bridgeReady) {
      appLog.info('[easy-apply] Bridge did not reconnect within 20s after FORCE_NAVIGATE')
      return false
    }

    appLog.info('[easy-apply] Bridge reconnected — checking for redirect...')
    await new Promise((r) => setTimeout(r, 3000))
    const secondReady = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5_000)
      bridgeEvents.once('bridge-ready', () => { clearTimeout(t); resolve(true) })
    })
    if (secondReady) {
      appLog.info('[easy-apply] Redirect detected (second bridge-ready) — waiting for modal render...')
      await new Promise((r) => setTimeout(r, 3000))
    }

    // Fast-fail guard: some listings bounce /apply back to /jobs/view with no
    // modal surface. Polling 20+ seconds here cannot recover that state.
    try {
      const quickDiag = await easyApplyBridgeCommand('DIAGNOSE_EASY_APPLY', {}, 'navigate', 'post_force_nav_quick_diag', 10_000)
      const quickDiagData = 'data' in quickDiag && quickDiag.data && typeof quickDiag.data === 'object'
        ? quickDiag.data as Record<string, unknown>
        : null
      if (quickDiag.ok && quickDiagData && diagnosticSuggestsNonApplyLanding(quickDiagData)) {
        const pageUrl = String(quickDiagData.url || '')
        appLog.info('[easy-apply] FORCE_NAVIGATE landed on non-apply job page; failing fast', {
          pageUrl: pageUrl.slice(0, 200)
        })
        applyTrace('easy_apply:sdui_non_apply_landing', { url: pageUrl.slice(0, 200) })
        return false
      }
    } catch (err) {
      appLog.debug('[easy-apply] quick diagnose after FORCE_NAVIGATE failed', err instanceof Error ? err.message : String(err))
    }

    let sduiModalFound = await pollForModal(14, 1500, 'sdui_modal_poll')
    if (!sduiModalFound) {
      appLog.info('[easy-apply] First SDUI modal-open attempt failed — retrying with NAVIGATE fallback')
      applyTrace('easy_apply:sdui_second_chance_nav', { sduiApplyUrl: sduiUrl })
      const navRetry = await easyApplyBridgeCommand('NAVIGATE', { url: sduiUrl }, 'navigate', 'sdui_second_chance_nav')
      if (navRetry.ok) {
        await new Promise((r) => setTimeout(r, 4_000))
        sduiModalFound = await pollForModal(8, 1200, 'sdui_modal_poll_retry')
      }
    }

    if (!sduiModalFound) {
      appLog.info('[easy-apply] Modal not found after polling — running page diagnostic')
      try {
        const diag = await easyApplyBridgeCommand('DIAGNOSE_EASY_APPLY', {}, 'navigate', 'post_force_nav_diag', 10_000)
        const diagData = 'data' in diag ? diag.data as Record<string, unknown> : {}
        const pageUrl = String(diagData.url || '')
        applyTrace('easy_apply:post_force_nav_diagnostic', {
          url: pageUrl.slice(0, 200), modalRootFound: diagData.modalRootFound,
          sduiFormFieldCount: diagData.sduiFormFieldCount, artdecoModals: diagData.artdecoModals,
          roleDialogs: diagData.roleDialogs, easyApplyModals: diagData.easyApplyModals,
          hasInteropOutlet: diagData.hasInteropOutlet
        })
        if (pageUrl && !pageUrl.includes('linkedin.com')) {
          appLog.warn('[easy-apply] Page redirected away from LinkedIn after FORCE_NAVIGATE', { pageUrl: pageUrl.slice(0, 200) })
          applyTrace('easy_apply:external_redirect_detected', { url: pageUrl.slice(0, 200) })
        }
      } catch (err) { appLog.warn('[easy-apply] Post-FORCE_NAVIGATE diagnostic failed:', err instanceof Error ? err.message : String(err)) }
    }
    return sduiModalFound
  } catch (err) {
    appLog.warn('[easy-apply] SDUI FORCE_NAVIGATE failed:', err instanceof Error ? err.message : String(err))
    return false
  }
}

/**
 * Locate and click the Easy Apply button using CDP (trusted events).
 * Flow: locate (pure) → CDP trusted click → verify modal → JS fallback → SDUI handler.
 */
export async function easyApplyClickApplyButton(
  onProgress?: (phase: string) => void,
  jobUrl?: string
): Promise<EasyApplyClickResult> {
  onProgress?.('Opening Easy Apply form...')
  let clickResult: BridgeCmdResult | null = null
  let cdpClickSucceeded = false
  let locatedSduiApplyUrl: string | undefined
  try {
    applyTrace('easy_apply:stage', { stage: 'click_easy_apply', waitAfterMs: 1500 })

    const tabId = getActiveLinkedInTabId()
    if (tabId != null) {
      const jobIdMatch = jobUrl?.match(/\/jobs\/view\/(\d+)/)
      const targetJobId = jobIdMatch ? jobIdMatch[1] : undefined
      const cdpLocate = await cdpLocateEasyApplyButton(tabId, targetJobId)
      if (cdpLocate) {
        if (!cdpLocate.ok) {
          applyTrace('easy_apply:cdp_locate_result', { detail: cdpLocate.detail, diag: cdpLocate.diag })
          if (cdpLocate.diag) appLog.info('[easy-apply] CDP locate diag:', cdpLocate.diag)
          if (cdpLocate.detail === 'already_applied') {
            return { earlyExit: { ok: false, phase: 'click_apply', detail: 'already_applied' }, clickResult: null, sduiApplyUrl: undefined, cdpClickSucceeded: false }
          }
        } else {
          appLog.info('[easy-apply] CDP located button (locate-only)', {
            x: cdpLocate.x, y: cdpLocate.y, w: cdpLocate.width, h: cdpLocate.height,
            tag: cdpLocate.tag, cls: cdpLocate.cls, text: cdpLocate.text,
            sdui: !!cdpLocate.sduiApplyUrl
          })
          applyTrace('easy_apply:cdp_locate_ok', { x: cdpLocate.x, y: cdpLocate.y, tag: cdpLocate.tag, sdui: !!cdpLocate.sduiApplyUrl })
          if (cdpLocate.sduiApplyUrl) locatedSduiApplyUrl = cdpLocate.sduiApplyUrl

          // Single click path: CDP trusted mouse click
          const cdp = await attemptCdpClick(cdpLocate.x, cdpLocate.y, cdpLocate.tag, tabId)
          cdpClickSucceeded = cdp.succeeded
          if (cdp.clickResult) clickResult = cdp.clickResult

          // CDP click failed → check if URL navigated to /apply/ (SDUI default nav happened)
          if (!cdp.succeeded) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const cdpData = (cdp.clickResult as any)?.data
            const urlAfter = String(cdpData?.url || '')
            const urlNavigatedToApply = urlAfter.includes('/apply/') || urlAfter.includes('openSDUIApplyFlow')

            if (urlNavigatedToApply) {
              // Trusted click didn't intercept — <a> default nav fired, we're on SDUI overview
              locatedSduiApplyUrl = locatedSduiApplyUrl || urlAfter.split('?')[0]
              appLog.info('[easy-apply] CDP click caused /apply/ navigation — delegating to SDUI handler', { url: urlAfter })
            } else if (!cdpData?.hasModal && !cdpData?.hasArtdecoModal) {
              // No modal, no navigation — try JS click as last resort
              appLog.info('[easy-apply] CDP click did not open modal — trying JS click fallback')
              applyTrace('easy_apply:cdp_click_fallback_to_js', { url: urlAfter })
              try {
                await sendCommand('CDP_ATTACH', { tabId }, 10_000)
                const jsFallbackExpr = `(async () => {
                  const sel = 'button.jobs-apply-button, a.jobs-apply-button, button[aria-label*="Easy Apply" i], a[aria-label*="Easy Apply" i]';
                  const el = [...document.querySelectorAll(sel)].find(e => {
                    const r = e.getBoundingClientRect();
                    return r.width > 0 && r.height > 0 && r.top > 100;
                  });
                  if (!el) return JSON.stringify({ ok: false, detail: 'no_button_for_js_fallback' });
                  el.click();
                  await new Promise(r => setTimeout(r, 2500));
                  return JSON.stringify({
                    ok: true,
                    url: location.href,
                    hasModal: !!document.querySelector('.jobs-easy-apply-modal, .artdeco-modal[role="dialog"]')
                  });
                })()`
                const jsRes = await sendCommand('CDP_COMMAND', {
                  tabId, method: 'Runtime.evaluate',
                  params: { expression: jsFallbackExpr, returnByValue: true, awaitPromise: true }
                }, 15_000)
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const jsVal = (jsRes as any)?.data?.result?.result?.value
                const jsParsed = jsVal ? JSON.parse(jsVal) : null
                if (jsParsed?.ok && (jsParsed?.hasModal || jsParsed?.url?.includes('/apply/'))) {
                  cdpClickSucceeded = true
                  clickResult = { ok: true, detail: 'clicked_easy_apply_js_fallback', data: jsParsed }
                  if (jsParsed.url?.includes('/apply/')) {
                    locatedSduiApplyUrl = jsParsed.url.split('?')[0]
                  }
                }
              } catch (jsErr) {
                appLog.warn('[easy-apply] JS click fallback failed:', jsErr instanceof Error ? jsErr.message : String(jsErr))
              } finally {
                try { await sendCommand('CDP_DETACH', { tabId }, 5_000) } catch { /* best effort */ }
              }
            }
          }
        }
      }
    }

    // Only do the early-exit check when there is no SDUI URL to fall back on.
    // If CDP located an SDUI button, handleSduiNavigation below should be tried
    // before giving up, even if the initial click did not open a modal.
    if (!clickResult?.ok && !locatedSduiApplyUrl) {
      const check = await checkFormAlreadyOpen()
      if (!check.formOpen) {
        const detail = String(clickResult?.detail || '')
        applyTrace('easy_apply:click_apply_failed', { detail: detail.slice(0, 300), ...check })
        return { earlyExit: { ok: false, phase: 'click_apply', detail: detail || 'Could not find Easy Apply button.' }, clickResult, sduiApplyUrl: undefined, cdpClickSucceeded }
      }
    }
    // Wait for modal to render
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000))

    const clickDataObj = (clickResult as { data?: unknown } | undefined)?.data
    const clickData = clickDataObj && typeof clickDataObj === 'object' ? clickDataObj as Record<string, unknown> : undefined
    const sduiApplyUrl = clickData?.sduiApplyUrl ? String(clickData.sduiApplyUrl) : locatedSduiApplyUrl
    const clickDetail = String(clickResult?.detail || '')

    if (sduiApplyUrl && !cdpClickSucceeded) {
      const opened = await handleSduiNavigation(sduiApplyUrl, cdpClickSucceeded, clickDetail)
      if (!opened) {
        appLog.info('[easy-apply] SDUI navigation could not open modal after retries', { sduiApplyUrl })
        applyTrace('easy_apply:sdui_modal_not_open_after_retries', { sduiApplyUrl, detail: clickDetail.slice(0, 180) })
        return {
          earlyExit: {
            ok: false,
            phase: 'click_apply',
            detail: "The Easy Apply form didn't open on this page. The job may have been removed or may not support Easy Apply."
          },
          clickResult,
          sduiApplyUrl,
          cdpClickSucceeded
        }
      }
    } else if (sduiApplyUrl && cdpClickSucceeded) {
      applyTrace('easy_apply:sdui_click_opened_modal', { sduiApplyUrl })
    }

    return { earlyExit: null, clickResult, sduiApplyUrl, cdpClickSucceeded }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    applyTrace('easy_apply:click_apply_exception', { message: msg.slice(0, 400) })
    return { earlyExit: { ok: false, phase: 'click_apply', detail: `Easy Apply click failed: ${msg}` }, clickResult, sduiApplyUrl: undefined, cdpClickSucceeded }
  }
}
