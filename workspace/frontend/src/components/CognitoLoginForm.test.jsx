import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { AuthStatus } from '../cognito/cognitoAuth'

vi.mock('../cognito/cognitoAuth', () => ({
  AuthStatus: {
    SUCCESS: 'SUCCESS',
    MFA_REQUIRED: 'MFA_REQUIRED',
    MFA_SETUP_REQUIRED: 'MFA_SETUP_REQUIRED',
    NEW_PASSWORD_REQUIRED: 'NEW_PASSWORD_REQUIRED',
  },
  signIn: vi.fn(),
  respondToMfaChallenge: vi.fn(),
  associateTotp: vi.fn(),
  verifyTotp: vi.fn(),
  completeNewPassword: vi.fn(),
  getAccessToken: vi.fn(),
}))
vi.mock('../cognito/session', () => ({ resolveIdentity: vi.fn() }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,QR') } }))

import CognitoLoginForm from './CognitoLoginForm'
import {
  signIn,
  respondToMfaChallenge,
  associateTotp,
  verifyTotp,
  completeNewPassword,
  getAccessToken,
} from '../cognito/cognitoAuth'
import { resolveIdentity } from '../cognito/session'

const USER = { id: 1, email: 'a@x.com', name: 'A', role: 'support' }

beforeEach(() => {
  getAccessToken.mockResolvedValue('access-token')
  resolveIdentity.mockResolvedValue(USER)
})
afterEach(() => vi.clearAllMocks())

function fillPassword() {
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'a@x.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Password-123!' } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('CognitoLoginForm', () => {
  it('offers public registration from the Cognito sign-in screen', () => {
    const onSignUp = vi.fn()
    render(<CognitoLoginForm onLogin={vi.fn()} onSignUp={onSignUp} />)

    fireEvent.click(screen.getByRole('button', { name: 'Register for access' }))

    expect(onSignUp).toHaveBeenCalledOnce()
  })

  it('logs in directly when no MFA is required', async () => {
    signIn.mockResolvedValue({ status: AuthStatus.SUCCESS })
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} />)
    fillPassword()
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({ access_token: 'access-token', user: USER }),
    )
    expect(signIn).toHaveBeenCalledWith('a@x.com', 'Password-123!')
  })

  it('prompts for a TOTP code then logs in', async () => {
    signIn.mockResolvedValue({ status: AuthStatus.MFA_REQUIRED, user: {} })
    respondToMfaChallenge.mockResolvedValue({
      status: AuthStatus.SUCCESS,
      tokens: { accessToken: 'final-mfa-access-token' },
    })
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} />)
    fillPassword()

    const codeInput = await screen.findByLabelText('Authentication code')
    fireEvent.change(codeInput, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: /verify/i }))

    await waitFor(() => expect(onLogin).toHaveBeenCalled())
    expect(respondToMfaChallenge).toHaveBeenCalledWith({}, '123456', 'SOFTWARE_TOKEN_MFA')
    expect(resolveIdentity).toHaveBeenCalledWith('final-mfa-access-token')
    expect(onLogin).toHaveBeenCalledWith({
      access_token: 'final-mfa-access-token',
      user: USER,
    })
  })

  it('shows an error for an incorrect MFA code and does not log in', async () => {
    signIn.mockResolvedValue({ status: AuthStatus.MFA_REQUIRED, user: {} })
    respondToMfaChallenge.mockRejectedValue(new Error('That code is incorrect. Try again.'))
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} />)
    fillPassword()
    fireEvent.change(await screen.findByLabelText('Authentication code'), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: /verify/i }))

    expect(await screen.findByText('That code is incorrect. Try again.')).toBeInTheDocument()
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('runs first-time TOTP enrollment: shows QR + secret, verifies, logs in', async () => {
    signIn.mockResolvedValue({ status: AuthStatus.MFA_SETUP_REQUIRED, user: {} })
    associateTotp.mockResolvedValue({ otpauthUri: 'otpauth://totp/x', secretCode: 'SECRET123' })
    verifyTotp.mockResolvedValue({
      status: AuthStatus.SUCCESS,
      tokens: { accessToken: 'final-setup-access-token' },
    })
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} />)
    fillPassword()

    // QR image + manual secret are shown.
    expect(await screen.findByAltText('Authenticator QR code')).toBeInTheDocument()
    expect(screen.getByText('SECRET123')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Code from your app'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm & finish/i }))

    await waitFor(() => expect(onLogin).toHaveBeenCalled())
    expect(verifyTotp).toHaveBeenCalledWith({}, '654321')
    expect(resolveIdentity).toHaveBeenCalledWith('final-setup-access-token')
  })

  it('shows a sign-in error on bad credentials', async () => {
    signIn.mockRejectedValue(new Error('Email or password is incorrect.'))
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} />)
    fillPassword()
    expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument()
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('blocks login (UI-only) when the DB role differs from the selected role', async () => {
    // User picked "admin" but the backend says they are "employee". The app
    // must NOT log them in under the wrong view; this is a UI guard only — the
    // backend still enforces the real role regardless.
    signIn.mockResolvedValue({ status: AuthStatus.SUCCESS })
    resolveIdentity.mockResolvedValue({ ...USER, role: 'employee' })
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} selectedRole="admin" />)
    fillPassword()
    expect(await screen.findByText(/registered as Staff/i)).toBeInTheDocument()
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('logs in when the DB role matches the selected role', async () => {
    signIn.mockResolvedValue({ status: AuthStatus.SUCCESS })
    resolveIdentity.mockResolvedValue({ ...USER, role: 'support' })
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} selectedRole="support" />)
    fillPassword()
    await waitFor(() => expect(onLogin).toHaveBeenCalled())
  })

  it('prompts for a new password (invited user) then logs in', async () => {
    signIn.mockResolvedValue({ status: AuthStatus.NEW_PASSWORD_REQUIRED, user: {} })
    completeNewPassword.mockResolvedValue({ status: AuthStatus.SUCCESS })
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} />)
    fillPassword()

    const newPw = await screen.findByLabelText('New password')
    fireEvent.change(newPw, { target: { value: 'A-brand-new-pass-123!' } })
    fireEvent.click(screen.getByRole('button', { name: /set password/i }))

    await waitFor(() => expect(onLogin).toHaveBeenCalled())
    expect(completeNewPassword).toHaveBeenCalledWith({}, 'A-brand-new-pass-123!')
  })

  // Regression: the "Session expired" bug. After NEW_PASSWORD_REQUIRED the SDK
  // session is not yet readable from storage, so getAccessToken() returns null.
  // Login must still succeed using the token threaded from the challenge
  // result, and that token must be passed to resolveIdentity.
  it('uses the token from the new-password result when the stored session is empty', async () => {
    signIn.mockResolvedValue({ status: AuthStatus.NEW_PASSWORD_REQUIRED, user: {} })
    completeNewPassword.mockResolvedValue({
      status: AuthStatus.SUCCESS,
      tokens: { accessToken: 'fresh-token-from-challenge' },
    })
    getAccessToken.mockResolvedValue(null) // store not populated yet
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} />)
    fillPassword()
    fireEvent.change(await screen.findByLabelText('New password'), { target: { value: 'A-brand-new-pass-123!' } })
    fireEvent.click(screen.getByRole('button', { name: /set password/i }))

    await waitFor(() => expect(onLogin).toHaveBeenCalled())
    expect(resolveIdentity).toHaveBeenCalledWith('fresh-token-from-challenge')
    expect(onLogin).toHaveBeenCalledWith({ access_token: 'fresh-token-from-challenge', user: USER })
    expect(getAccessToken).not.toHaveBeenCalled()
  })

  it('surfaces the backend identity error instead of forcing a generic Session expired', async () => {
    signIn.mockResolvedValue({ status: AuthStatus.SUCCESS, tokens: { accessToken: 'fresh-token' } })
    resolveIdentity.mockRejectedValue(new Error('No account is linked to this identity.'))
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} />)
    fillPassword()
    expect(await screen.findByText('No account is linked to this identity.')).toBeInTheDocument()
    expect(onLogin).not.toHaveBeenCalled()
  })

  it('fails cleanly if no token can be obtained at all', async () => {
    signIn.mockResolvedValue({ status: AuthStatus.SUCCESS }) // no tokens on result
    getAccessToken.mockResolvedValue(null) // and nothing in the store
    const onLogin = vi.fn()
    render(<CognitoLoginForm onLogin={onLogin} />)
    fillPassword()
    expect(await screen.findByText(/Could not establish a session/i)).toBeInTheDocument()
    expect(onLogin).not.toHaveBeenCalled()
  })
})
