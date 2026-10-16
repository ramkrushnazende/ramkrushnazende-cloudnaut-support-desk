import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock the cognito wrapper so we can control getAccessToken, and the config so
// we can flip auth mode per test.
vi.mock('./cognito/cognitoAuth', () => ({
  getAccessToken: vi.fn(),
}))
vi.mock('./cognito/config', () => ({
  isCognitoMode: vi.fn(),
}))

import { apiFetch } from './api'
import { getAccessToken } from './cognito/cognitoAuth'
import { isCognitoMode } from './cognito/config'

function lastFetchHeaders() {
  const [, init] = globalThis.fetch.mock.calls.at(-1)
  return init.headers
}

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
  localStorage.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('apiFetch token handling', () => {
  it('attaches the legacy localStorage token in legacy mode', async () => {
    isCognitoMode.mockReturnValue(false)
    localStorage.setItem('supportDeskToken', 'legacy-token-123')
    await apiFetch('/requests')
    expect(lastFetchHeaders().get('Authorization')).toBe('Bearer legacy-token-123')
    // Cognito token source is never consulted in legacy mode.
    expect(getAccessToken).not.toHaveBeenCalled()
  })

  it('attaches the Cognito access token in cognito mode', async () => {
    isCognitoMode.mockReturnValue(true)
    getAccessToken.mockResolvedValue('cognito-access-xyz')
    // Even if a stale legacy token exists, it must NOT be used in cognito mode.
    localStorage.setItem('supportDeskToken', 'stale-legacy')
    await apiFetch('/requests')
    expect(lastFetchHeaders().get('Authorization')).toBe('Bearer cognito-access-xyz')
  })

  it('sends no Authorization header when there is no token', async () => {
    isCognitoMode.mockReturnValue(true)
    getAccessToken.mockResolvedValue(null)
    await apiFetch('/requests')
    expect(lastFetchHeaders().get('Authorization')).toBeNull()
  })

  it('uses an explicit authToken override and does not consult the store', async () => {
    isCognitoMode.mockReturnValue(true)
    await apiFetch('/auth/whoami', { authToken: 'explicit-fresh-token' })
    expect(lastFetchHeaders().get('Authorization')).toBe('Bearer explicit-fresh-token')
    // The stored-session lookup must be bypassed when an override is provided.
    expect(getAccessToken).not.toHaveBeenCalled()
    // authToken must not leak into fetch init.
    const [, init] = globalThis.fetch.mock.calls.at(-1)
    expect('authToken' in init).toBe(false)
  })

  it('sets JSON content-type for a non-FormData body', async () => {
    isCognitoMode.mockReturnValue(false)
    await apiFetch('/requests', { method: 'POST', body: JSON.stringify({ a: 1 }) })
    expect(lastFetchHeaders().get('Content-Type')).toBe('application/json')
  })

  it('does not force JSON content-type for FormData', async () => {
    isCognitoMode.mockReturnValue(false)
    const body = new FormData()
    body.append('file', new Blob(['x']), 'x.txt')
    await apiFetch('/requests/1/attachments', { method: 'POST', body })
    expect(lastFetchHeaders().get('Content-Type')).toBeNull()
  })
})
