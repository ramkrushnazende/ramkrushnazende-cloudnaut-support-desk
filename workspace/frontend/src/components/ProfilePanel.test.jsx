import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../cognito/cognitoAuth', () => ({
  updatePhoneNumber: vi.fn(),
  sendPhoneVerificationCode: vi.fn(),
  confirmPhoneNumber: vi.fn(),
  setupTotp: vi.fn(),
  confirmTotpSetup: vi.fn(),
  disableTotp: vi.fn(),
  changePassword: vi.fn(),
}))
vi.mock('../api', () => ({ apiFetch: vi.fn() }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,QR') } }))

import ProfilePanel from './ProfilePanel'
import {
  updatePhoneNumber,
  sendPhoneVerificationCode,
  confirmPhoneNumber,
  setupTotp,
  confirmTotpSetup,
  changePassword,
} from '../cognito/cognitoAuth'
import { apiFetch } from '../api'

const USER = {
  id: 1, name: 'Asha', email: 'asha@x.com', role: 'support',
  phone_number: '+911111111111', mfa_enabled: false,
}

beforeEach(() => {
  updatePhoneNumber.mockResolvedValue({ status: 'PENDING_VERIFICATION' })
  sendPhoneVerificationCode.mockResolvedValue({ status: 'CODE_SENT' })
  confirmPhoneNumber.mockResolvedValue({ status: 'VERIFIED' })
  setupTotp.mockResolvedValue({ otpauthUri: 'otpauth://totp/x', secretCode: 'SECRET123' })
  confirmTotpSetup.mockResolvedValue({ status: 'SUCCESS' })
  changePassword.mockResolvedValue({ status: 'CHANGED' })
  apiFetch.mockImplementation((path) => Promise.resolve(path === '/profile/mfa'
    ? { ok: true, json: async () => ({ mfa_enabled: false }) }
    : { ok: true, json: async () => ({ phone_number: '+919999999999', phone_verified: true }) }))
})
afterEach(() => vi.clearAllMocks())

describe('ProfilePanel', () => {
  it('shows DB-authoritative identity fields including role (read-only) and MFA status', async () => {
    render(<ProfilePanel user={USER} />)
    expect(await screen.findByText('Not enabled')).toBeInTheDocument()
    expect(screen.getByText('Asha', { selector: 'dd' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Asha profile picture' })).toHaveTextContent('A')
    expect(screen.getByText('asha@x.com')).toBeInTheDocument()
    expect(screen.getByText('support', { selector: 'dd' })).toBeInTheDocument()
    expect(screen.getByText('Not enabled')).toBeInTheDocument()
    // Role is displayed, not an editable control.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('prevents saved email and current-password autofill in profile inputs', async () => {
    render(<ProfilePanel user={USER} />)
    await screen.findByText('Not enabled')

    expect(screen.getByLabelText(/Phone/)).toHaveAttribute('autocomplete', 'off')
    expect(screen.getByLabelText(/Phone/).closest('form')).toHaveAttribute('autocomplete', 'off')
    expect(screen.getByLabelText('Current password')).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText('Current password').closest('form')).toHaveAttribute('autocomplete', 'off')
  })

  it('saves a phone number and sends a verification code, then verifies', async () => {
    render(<ProfilePanel user={USER} />)
    await screen.findByText('Not enabled')
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '+919999999999' } })
    fireEvent.click(screen.getByRole('button', { name: /save & send code/i }))

    await waitFor(() => expect(sendPhoneVerificationCode).toHaveBeenCalled())
    expect(updatePhoneNumber).toHaveBeenCalledWith('+919999999999')

    const codeInput = await screen.findByLabelText('Verification code')
    fireEvent.change(codeInput, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: /verify phone/i }))
    await waitFor(() => expect(confirmPhoneNumber).toHaveBeenCalledWith('123456'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/profile/phone', { method: 'POST' }))
    expect(screen.getByText('+919999999999', { selector: 'dd' })).toBeInTheDocument()
    expect(await screen.findByText('Phone number verified and saved.')).toBeInTheDocument()
  })

  it('allows retrying the profile save after Cognito accepted the SMS code', async () => {
    let phoneSyncAttempts = 0
    apiFetch.mockImplementation((path) => Promise.resolve(path === '/profile/mfa'
      ? { ok: true, json: async () => ({ mfa_enabled: false }) }
      : ++phoneSyncAttempts === 1
        ? { ok: false, json: async () => ({ detail: 'Service unavailable.' }) }
        : { ok: true, json: async () => ({ phone_number: '+919999999999', phone_verified: true }) }))
    render(<ProfilePanel user={USER} />)
    await screen.findByText('Not enabled')
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '+919999999999' } })
    fireEvent.click(screen.getByRole('button', { name: /save & send code/i }))
    const codeInput = await screen.findByLabelText('Verification code')
    fireEvent.change(codeInput, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: /verify phone/i }))

    expect(await screen.findByText('Service unavailable.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /retry saving verified phone/i }))

    await waitFor(() => expect(apiFetch.mock.calls.filter(([path]) => path === '/profile/phone')).toHaveLength(2))
    expect(confirmPhoneNumber).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Phone number verified and saved.')).toBeInTheDocument()
  })

  it('rejects invalid phone formats without calling Cognito', async () => {
    render(<ProfilePanel user={USER} />)
    await screen.findByText('Not enabled')
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9999999999' } })
    fireEvent.click(screen.getByRole('button', { name: /save & send code/i }))

    expect(await screen.findByText(/international format/)).toBeInTheDocument()
    expect(updatePhoneNumber).not.toHaveBeenCalled()
    expect(sendPhoneVerificationCode).not.toHaveBeenCalled()
  })

  it('runs TOTP setup: shows QR + secret and confirms', async () => {
    let mfaSyncCount = 0
    apiFetch.mockImplementation((path) => Promise.resolve(path === '/profile/mfa'
      ? { ok: true, json: async () => ({ mfa_enabled: ++mfaSyncCount > 1 }) }
      : { ok: true, json: async () => ({ phone_number: '+919999999999', phone_verified: true }) }))
    render(<ProfilePanel user={USER} />)
    fireEvent.click(await screen.findByRole('button', { name: /set up authenticator/i }))

    expect(await screen.findByAltText('Authenticator QR code')).toBeInTheDocument()
    expect(screen.getByText('SECRET123')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Code from your app'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: /confirm authenticator/i }))
    expect(await screen.findByText('Authenticator enabled.')).toBeInTheDocument()
    expect(screen.getByText('Enabled')).toBeInTheDocument()
    await waitFor(() => expect(confirmTotpSetup).toHaveBeenCalledWith('654321'))
  })

  it('syncs verified Cognito TOTP status and updates the profile indicator', async () => {
    apiFetch.mockImplementation((path) => Promise.resolve(path === '/profile/mfa' ? {
      ok: true,
      json: async () => ({ mfa_enabled: true }),
    } : { ok: true, json: async () => ({ phone_number: '+919999999999', phone_verified: true }) }))
    render(<ProfilePanel user={USER} />)
    expect(await screen.findByRole('button', { name: /reset authenticator/i })).toBeInTheDocument()
    expect(screen.getByText('Enabled')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /reset authenticator/i }))
    fireEvent.change(await screen.findByLabelText('Code from your app'), {
      target: { value: '654321' },
    })
    fireEvent.click(screen.getByRole('button', { name: /confirm authenticator/i }))

    expect(await screen.findByText('Authenticator enabled.')).toBeInTheDocument()
    expect(screen.getByText('Enabled')).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledWith('/profile/mfa', { method: 'POST' })
  })

  it('reconciles an enabled Cognito authenticator when the profile opens', async () => {
    apiFetch.mockImplementation((path) => Promise.resolve(path === '/profile/mfa' ? {
      ok: true,
      json: async () => ({ mfa_enabled: true }),
    } : { ok: true, json: async () => ({ phone_number: '+919999999999', phone_verified: true }) }))
    render(<ProfilePanel user={{ ...USER, mfa_enabled: true }} />)
    expect(await screen.findByText('Enabled')).toBeInTheDocument()
    expect(screen.getByText('Enabled')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reset authenticator/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /disable authenticator/i })).toBeInTheDocument()
  })

  it('surfaces an error when phone save fails', async () => {
    updatePhoneNumber.mockRejectedValue(new Error('Invalid phone number.'))
    render(<ProfilePanel user={USER} />)
    fireEvent.click(screen.getByRole('button', { name: /save & send code/i }))
    expect(await screen.findByText('Invalid phone number.')).toBeInTheDocument()
  })

  it('changes the Cognito password and clears the password fields on success', async () => {
    render(<ProfilePanel user={USER} />)
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldPassword!123' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPassword!123' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPassword!123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    await waitFor(() => expect(changePassword).toHaveBeenCalledWith('OldPassword!123', 'NewPassword!123'))
    expect(await screen.findByText('Your password has been changed.')).toBeInTheDocument()
    expect(screen.getByLabelText('Current password')).toHaveValue('')
    expect(screen.getByLabelText('New password')).toHaveValue('')
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('')
  })

  it('does not call Cognito when confirmation does not match', async () => {
    render(<ProfilePanel user={USER} />)
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'OldPassword!123' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPassword!123' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'DifferentPassword!123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByText('New passwords do not match.')).toBeInTheDocument()
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('surfaces a Cognito password-change failure without logging credentials', async () => {
    changePassword.mockRejectedValue(new Error('The current password is incorrect.'))
    render(<ProfilePanel user={USER} />)
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'WrongPassword!123' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'NewPassword!123' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'NewPassword!123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))

    expect(await screen.findByText('The current password is incorrect.')).toBeInTheDocument()
  })
})
