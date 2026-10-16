// API base URL. In production builds this is injected from VITE_API_URL
// (see .env.production); locally it falls back to the Vite dev backend.
// Only a public URL is embedded here — never a secret.
import { isCognitoMode } from './cognito/config'
import { getAccessToken } from './cognito/cognitoAuth'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000'

// Resolve the bearer token for the current auth mode. In Cognito mode the
// token is the Cognito ACCESS token held in the SDK session (refreshed as
// needed); in legacy mode it is the existing localStorage app token. Role is
// never derived from this token — the backend resolves it from PostgreSQL.
async function resolveAuthToken() {
  if (isCognitoMode()) {
    return getAccessToken()
  }
  return localStorage.getItem('supportDeskToken')
}
const MIME_TYPE_BY_EXTENSION = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
}

export async function apiFetch(path, options = {}) {
  // An explicit options.authToken overrides the stored-session lookup. This is
  // used right after a Cognito challenge completes (new-password / MFA), when
  // the SDK session may not yet be readable from storage, so we must use the
  // token the SDK just returned rather than re-deriving it.
  const { authToken, ...fetchOptions } = options
  const token = authToken || (await resolveAuthToken())
  const headers = new Headers(fetchOptions.headers || {})
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (
    fetchOptions.body &&
    !(typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData) &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`${API_URL}${path}`, { ...fetchOptions, headers })
}

export function getDashboardSummary() {
  return apiFetch('/dashboard/summary')
}

// Supported server-side filters on GET /requests. Anything else is ignored so
// the frontend never silently relies on an unsupported param.
const REQUEST_FILTER_KEYS = [
  'status',
  'assigned_to',
  'assignment',
  'category',
  'priority',
  'created_from',
  'created_to',
  'sort_by',
  'sort_order',
]

export function buildRequestQuery(filters = {}) {
  const params = new URLSearchParams()
  for (const key of REQUEST_FILTER_KEYS) {
    const value = filters[key]
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, value)
    }
  }
  const query = params.toString()
  return query ? `/requests?${query}` : '/requests'
}

export function listRequests(filters = {}) {
  return apiFetch(buildRequestQuery(filters))
}

export function listAccessRequests(status = 'pending') {
  return apiFetch(`/access-requests?status=${encodeURIComponent(status)}`)
}

export function listTeamMembers(activeOnly = false) {
  return apiFetch(`/team-members?active_only=${activeOnly ? 'true' : 'false'}`)
}

export function listRequestAttachments(requestId) {
  return apiFetch(`/requests/${requestId}/attachments`)
}

export function uploadRequestAttachment(requestId, file) {
  const body = new FormData()
  const extension = file.name.split('.').pop()?.toLowerCase()
  const content = file.type
    ? file
    : new Blob([file], { type: MIME_TYPE_BY_EXTENSION[extension] || 'application/octet-stream' })
  body.append('file', content, file.name)
  return apiFetch(`/requests/${requestId}/attachments`, {
    method: 'POST',
    body,
  })
}

export function fetchRequestAttachment(attachmentId) {
  return apiFetch(`/attachments/${attachmentId}`)
}

export function deleteRequestAttachment(attachmentId) {
  return apiFetch(`/attachments/${attachmentId}`, {
    method: 'DELETE',
  })
}
