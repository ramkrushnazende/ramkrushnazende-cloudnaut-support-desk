// Cognito session identity resolution (Phase c2).
//
// After a successful Cognito sign-in the SPA holds an access token but NOT the
// user's application role. Role and active status are authoritative in
// PostgreSQL, so we resolve them from the backend via GET /auth/whoami (which
// validates the token again and returns {id,email,name,role}). The token is
// never decoded for role on the client.

import { apiFetch } from '../api'

export class SessionExpiredError extends Error {
  constructor(message = 'Session expired.') {
    super(message)
    this.name = 'SessionExpiredError'
  }
}

function logIdentityResolutionFailure(event, payload) {
  console.warn('[auth-diagnostic]', {
    event,
    path: '/auth/whoami',
    category: 'identity_resolution',
    ...payload,
  })
}

/**
 * Resolve the DB-authoritative identity for the current (Cognito) session.
 * Returns the user object {id,email,name,role}. Throws SessionExpiredError on
 * 401 so the caller can send the user back to sign-in.
 */
export async function resolveIdentity(authToken) {
  // When called right after a Cognito challenge completes, pass the freshly
  // minted access token explicitly so the request is authenticated even if the
  // SDK session is not yet readable from storage. Without an argument it falls
  // back to the stored session (used for session restore on page reload).
  const response = await apiFetch('/auth/whoami', authToken ? { authToken } : {})
  const requestId = response.headers?.get?.('x-request-id') || 'n/a'

  if (response.status === 401) {
    logIdentityResolutionFailure('resolveIdentity:401', {
      status: response.status,
      requestId,
      authMode: 'cognito',
    })
    throw new SessionExpiredError('Sign-in could not be verified. Please sign in again.')
  }

  if (response.status === 403) {
    logIdentityResolutionFailure('resolveIdentity:403', {
      status: response.status,
      requestId,
      authMode: 'cognito',
    })
    throw new Error('Your account is not active or authorized. Contact your administrator.')
  }

  if (!response.ok) {
    const temporarilyUnavailable = [502, 503, 504].includes(response.status)
    logIdentityResolutionFailure('resolveIdentity:error', {
      status: response.status,
      requestId,
      authMode: 'cognito',
    })
    throw new Error(temporarilyUnavailable
      ? 'Sign-in is temporarily unavailable. Please try again.'
      : 'Could not resolve your account. Please try again.')
  }
  return response.json()
}
