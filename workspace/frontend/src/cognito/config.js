// Cognito frontend configuration (Phase c).
//
// All values here are PUBLIC and safe to ship in a browser bundle: the auth
// mode flag and the Cognito User Pool ID / public App Client ID (the client has
// NO secret — see infra). No AWS credentials or secrets are ever placed here.
//
// Cognito is the primary authentication mechanism. VITE_AUTH_MODE may be set
// explicitly to 'cognito' or 'legacy'; when it is UNSET, the app defaults to
// Cognito IF the pool/client are configured, and otherwise falls back to legacy
// (so local development without Cognito env vars still works). Production
// (.env.production) sets VITE_AUTH_MODE=cognito + the pool/client IDs.

const AUTH_MODE_LEGACY = 'legacy'
const AUTH_MODE_COGNITO = 'cognito'

export function getCognitoConfig() {
  return {
    userPoolId: (import.meta.env.VITE_COGNITO_USER_POOL_ID || '').trim(),
    clientId: (import.meta.env.VITE_COGNITO_APP_CLIENT_ID || '').trim(),
    region: (import.meta.env.VITE_AWS_REGION || '').trim(),
  }
}

export function isCognitoConfigured() {
  const { userPoolId, clientId } = getCognitoConfig()
  return Boolean(userPoolId && clientId)
}

export function getAuthMode() {
  const raw = (import.meta.env.VITE_AUTH_MODE || '').trim().toLowerCase()
  if (raw === AUTH_MODE_COGNITO) return AUTH_MODE_COGNITO
  if (raw === AUTH_MODE_LEGACY) return AUTH_MODE_LEGACY
  // Unset: prefer Cognito when it is configured; else legacy for local dev.
  return isCognitoConfigured() ? AUTH_MODE_COGNITO : AUTH_MODE_LEGACY
}

export function isCognitoMode() {
  return getAuthMode() === AUTH_MODE_COGNITO
}

export { AUTH_MODE_LEGACY, AUTH_MODE_COGNITO }
