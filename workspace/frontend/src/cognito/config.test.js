import { describe, it, expect, afterEach, vi } from 'vitest'

import {
  getAuthMode,
  isCognitoMode,
  getCognitoConfig,
  isCognitoConfigured,
  AUTH_MODE_LEGACY,
  AUTH_MODE_COGNITO,
} from './config'

afterEach(() => vi.unstubAllEnvs())

describe('auth mode', () => {
  it('defaults to legacy when unset AND Cognito is not configured (local dev)', () => {
    vi.stubEnv('VITE_AUTH_MODE', '')
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', '')
    vi.stubEnv('VITE_COGNITO_APP_CLIENT_ID', '')
    expect(getAuthMode()).toBe(AUTH_MODE_LEGACY)
    expect(isCognitoMode()).toBe(false)
  })

  it('defaults to cognito when unset BUT Cognito is configured', () => {
    vi.stubEnv('VITE_AUTH_MODE', '')
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'ap-south-1_X')
    vi.stubEnv('VITE_COGNITO_APP_CLIENT_ID', 'client')
    expect(getAuthMode()).toBe(AUTH_MODE_COGNITO)
    expect(isCognitoMode()).toBe(true)
  })

  it('honours an explicit legacy override even when Cognito is configured', () => {
    vi.stubEnv('VITE_AUTH_MODE', 'legacy')
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'ap-south-1_X')
    vi.stubEnv('VITE_COGNITO_APP_CLIENT_ID', 'client')
    expect(getAuthMode()).toBe(AUTH_MODE_LEGACY)
  })

  it('falls back to legacy for an unrecognised value when Cognito is unconfigured', () => {
    vi.stubEnv('VITE_AUTH_MODE', 'something-else')
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', '')
    vi.stubEnv('VITE_COGNITO_APP_CLIENT_ID', '')
    expect(getAuthMode()).toBe(AUTH_MODE_LEGACY)
  })

  it('activates cognito for the explicit value', () => {
    vi.stubEnv('VITE_AUTH_MODE', 'cognito')
    expect(getAuthMode()).toBe(AUTH_MODE_COGNITO)
    expect(isCognitoMode()).toBe(true)
  })
})

describe('cognito config', () => {
  it('reports configured only when pool + client are present', () => {
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', '')
    vi.stubEnv('VITE_COGNITO_APP_CLIENT_ID', '')
    expect(isCognitoConfigured()).toBe(false)

    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'ap-south-1_X')
    vi.stubEnv('VITE_COGNITO_APP_CLIENT_ID', 'client')
    vi.stubEnv('VITE_AWS_REGION', 'ap-south-1')
    expect(isCognitoConfigured()).toBe(true)
    expect(getCognitoConfig()).toEqual({
      userPoolId: 'ap-south-1_X',
      clientId: 'client',
      region: 'ap-south-1',
    })
  })
})
