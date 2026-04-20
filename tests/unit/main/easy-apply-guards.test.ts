import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EasyApplyResult } from '../../../src/main/easy-apply/shared'

const sharedMocks = vi.hoisted(() => ({
  easyApplyBridgeCommand: vi.fn(),
  isStaleExtensionResult: vi.fn((result: unknown) => {
    return !!result && typeof result === 'object' && (result as { blockReason?: unknown }).blockReason === 'extension_stale'
  })
}))

const bridgeMocks = vi.hoisted(() => ({
  sendCommand: vi.fn().mockResolvedValue({ ok: true }),
  getActiveLinkedInTabId: vi.fn(() => null),
  bridgeEvents: {
    once: vi.fn((event: string, cb: () => void) => {
      if (event === 'bridge-ready') cb()
    })
  }
}))

vi.mock('../../../src/main/easy-apply/shared', () => ({
  easyApplyBridgeCommand: (...args: unknown[]) =>
    sharedMocks.easyApplyBridgeCommand(...args) as ReturnType<typeof sharedMocks.easyApplyBridgeCommand>,
  isStaleExtensionResult: (result: unknown) => sharedMocks.isStaleExtensionResult(result)
}))

vi.mock('../../../src/main/bridge', () => ({
  sendCommand: (...args: unknown[]) => bridgeMocks.sendCommand(...args) as ReturnType<typeof bridgeMocks.sendCommand>,
  getActiveLinkedInTabId: () => bridgeMocks.getActiveLinkedInTabId(),
  bridgeEvents: bridgeMocks.bridgeEvents
}))

vi.mock('../../../src/main/apply-trace', () => ({
  applyTrace: vi.fn()
}))

vi.mock('../../../src/main/app-log', () => ({
  appLog: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }
}))

const nonApplyLandingDiag = {
  url: 'https://www.linkedin.com/jobs/view/1234567890/',
  modalRootFound: false,
  hasInteropOutlet: false,
  easyApplyModals: 0,
  roleDialogs: 0,
  artdecoModals: 0,
  sduiFormFieldCount: 0
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-14T06:30:00.000Z'))
  sharedMocks.easyApplyBridgeCommand.mockReset()
  bridgeMocks.sendCommand.mockReset()
  bridgeMocks.sendCommand.mockResolvedValue({ ok: true })
  bridgeMocks.getActiveLinkedInTabId.mockReset()
  bridgeMocks.getActiveLinkedInTabId.mockReturnValue(null)
  bridgeMocks.bridgeEvents.once.mockClear()
  bridgeMocks.bridgeEvents.once.mockImplementation((event: string, cb: () => void) => {
    if (event === 'bridge-ready') cb()
  })
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('easy-apply guards', () => {
  it('returns a user-facing unavailable message when SDUI force navigate lands back on jobs/view', async () => {
    // Simulate an active LinkedIn tab so the CDP path is taken.
    bridgeMocks.getActiveLinkedInTabId.mockReturnValue(123)

    // Mock sendCommand for CDP operations:
    //   cdpLocateEasyApplyButton → finds an SDUI <a> button (full URL preserved)
    //   attemptCdpClick post-click check → no modal opened
    //   JS fallback → no button found (falls through to SDUI handler)
    bridgeMocks.sendCommand.mockImplementation((command: string, args: unknown) => {
      if (command === 'CDP_ATTACH') return Promise.resolve({ ok: true })
      if (command === 'CDP_DETACH') return Promise.resolve({ ok: true })
      if (command === 'CDP_COMMAND') {
        const method = (args as Record<string, unknown>)?.method as string | undefined
        if (method === 'Input.dispatchMouseEvent') return Promise.resolve({ ok: true })
        if (method === 'Runtime.evaluate') {
          const expr = String(((args as Record<string, unknown>)?.params as Record<string, unknown>)?.expression || '')
          // cdpLocateEasyApplyButton expression — identified by the SDUI selector it injects
          if (expr.includes('openSDUIApplyFlow')) {
            return Promise.resolve({
              ok: true,
              data: { result: { result: { type: 'string', value: JSON.stringify({
                ok: true, x: 100, y: 200, width: 80, height: 30,
                tag: 'A', isSDUI: true,
                sduiApplyUrl: 'https://www.linkedin.com/jobs/view/1234567890/?openSDUIApplyFlow=true'
              }) } } }
            })
          }
          // Post-click check or JS fallback — no modal, still on jobs/view
          return Promise.resolve({
            ok: true,
            data: { result: { result: { type: 'string', value: JSON.stringify({
              url: 'https://www.linkedin.com/jobs/view/1234567890/',
              hasModal: false, hasArtdecoModal: false, inputCount: 0
            }) } } }
          })
        }
      }
      return Promise.resolve({ ok: true })
    })

    sharedMocks.easyApplyBridgeCommand.mockImplementation((action: string) => {
      if (action === 'FORCE_NAVIGATE') {
        return Promise.resolve({ ok: true, detail: 'force_navigated' })
      }
      if (action === 'DIAGNOSE_EASY_APPLY') {
        return Promise.resolve({ ok: true, detail: 'diagnose_ok', data: nonApplyLandingDiag })
      }
      return Promise.resolve({ ok: false, detail: `unexpected_action:${action}` })
    })

    const { easyApplyClickApplyButton } = await import('../../../src/main/easy-apply/click-apply')
    const runPromise = easyApplyClickApplyButton()
    await vi.runAllTimersAsync()
    const result = await runPromise

    expect(result.earlyExit?.ok).toBe(false)
    expect(result.earlyExit?.phase).toBe('click_apply')
    expect(result.earlyExit?.detail || '').toMatch(/form didn't open/i)
    expect(result.sduiApplyUrl || '').toContain('openSDUIApplyFlow=true')
    expect(sharedMocks.easyApplyBridgeCommand).toHaveBeenCalledWith(
      'DIAGNOSE_EASY_APPLY',
      {},
      'navigate',
      'post_force_nav_quick_diag',
      10_000
    )
  })

  it('returns stale extension result when warning-check page text action is stale', async () => {
    const stale: EasyApplyResult = {
      ok: false,
      phase: 'navigate',
      detail: 'Extension outdated. Reload LinkinReachly in Chrome’s Extensions page, then retry.',
      blockReason: 'extension_stale',
      blockStage: 'linkedin_warning_check'
    }

    sharedMocks.easyApplyBridgeCommand.mockImplementation((action: string) => {
      if (action === 'NAVIGATE') return Promise.resolve({ ok: true, detail: 'navigated' })
      if (action === 'SCROLL_PAGE') return Promise.resolve({ ok: true, detail: 'scrolled' })
      if (action === 'CHECK_SUCCESS_SCREEN') return Promise.resolve({ ok: false, detail: 'not_success' })
      if (action === 'GET_PAGE_TEXT') return Promise.resolve(stale)
      return Promise.resolve({ ok: false, detail: `unexpected_action:${action}` })
    })

    const { easyApplyNavigate } = await import('../../../src/main/easy-apply/navigate')
    const runPromise = easyApplyNavigate('https://www.linkedin.com/jobs/view/1234567890/')
    await vi.runAllTimersAsync()
    const result = await runPromise

    expect(result).toEqual(stale)
    expect(sharedMocks.easyApplyBridgeCommand).toHaveBeenCalledWith(
      'GET_PAGE_TEXT',
      {},
      'navigate',
      'linkedin_warning_check',
      5_000
    )
  })
})
