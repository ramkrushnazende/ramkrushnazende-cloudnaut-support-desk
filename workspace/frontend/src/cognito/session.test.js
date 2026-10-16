import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../api', () => ({ apiFetch: vi.fn() }))

import { resolveIdentity, SessionExpiredError } from './session'
import { apiFetch } from '../api'

afterEach(() => vi.clearAllMocks())

describe('resolveIdentity', () => {
  it('returns the DB-authoritative identity on 200 (no explicit token)', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 3, email: 'a@x.com', name: 'A', role: 'support' }),
    })
    const user = await resolveIdentity()
    expect(user).toEqual({ id: 3, email: 'a@x.com', name: 'A', role: 'support' })
    expect(apiFetch).toHaveBeenCalledWith('/auth/whoami', {})
  })

  it('forwards an explicit access token to apiFetch (post-challenge path)', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 1, role: 'admin' }) })
    await resolveIdentity('fresh-token')
    expect(apiFetch).toHaveBeenCalledWith('/auth/whoami', { authToken: 'fresh-token' })
  })

  it('shows a safe sign-in error on 401 without exposing backend details', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ detail: 'No account is linked to this identity.' }) })
    await expect(resolveIdentity()).rejects.toBeInstanceOf(SessionExpiredError)
    await expect(resolveIdentity()).rejects.toThrow(
      'Sign-in could not be verified. Please sign in again.',
    )
  })

  it('shows an account-access message for 403 without exposing backend details', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, json: async () => ({ detail: 'private backend detail' }) })
    await expect(resolveIdentity()).rejects.toThrow(
      'Your account is not active or authorized. Contact your administrator.',
    )
  })

  it('shows a retry message for authentication service failures', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: 'private backend detail' }) })
    await expect(resolveIdentity()).rejects.toThrow(
      'Sign-in is temporarily unavailable. Please try again.',
    )
  })
})
