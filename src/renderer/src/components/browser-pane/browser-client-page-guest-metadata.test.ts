import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ recordBreadcrumb: vi.fn() }))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: mocks.recordBreadcrumb
}))

import { removeBrowserClientPageWebview } from './browser-client-page-guest-metadata'

/** Verbatim from Electron 43.4.1: main destroyed the guest, the tag still holds its id. */
function invalidGuestInstanceId(): Error {
  return new Error('Invalid guestInstanceId: 7')
}

function deadGuestWebview(): Electron.WebviewTag {
  return {
    remove: vi.fn(() => {
      throw invalidGuestInstanceId()
    })
  } as unknown as Electron.WebviewTag
}

describe('removeBrowserClientPageWebview', () => {
  it('removes a live webview without recording a breadcrumb', () => {
    const webview = { remove: vi.fn() } as unknown as Electron.WebviewTag

    removeBrowserClientPageWebview(webview)

    expect(webview.remove).toHaveBeenCalledOnce()
    expect(mocks.recordBreadcrumb).not.toHaveBeenCalled()
  })

  it('swallows Invalid guestInstanceId thrown by a dead guest instead of propagating it', () => {
    const webview = deadGuestWebview()

    expect(() => removeBrowserClientPageWebview(webview)).not.toThrow()
    expect(mocks.recordBreadcrumb).toHaveBeenCalledWith(
      'browser_client_page_webview_removal_failed',
      expect.objectContaining({ errorMessage: 'Invalid guestInstanceId: 7' })
    )
  })
})
