import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import ForgotPasswordForm from './ForgotPasswordForm'
import { confirmPasswordReset, startPasswordReset } from '../cognito/cognitoAuth'

vi.mock('../api', () => ({ apiFetch: vi.fn() }))
vi.mock('../cognito/cognitoAuth', () => ({
  confirmPasswordReset: vi.fn(),
  startPasswordReset: vi.fn(),
}))

afterEach(() => vi.clearAllMocks())

describe('ForgotPasswordForm', () => {
  it('sends a Cognito reset code and confirms the new password', async () => {
    startPasswordReset.mockResolvedValue({ status: 'CODE_SENT' })
    confirmPasswordReset.mockResolvedValue({ status: 'RESET' })
    render(<ForgotPasswordForm cognitoMode onBack={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'user@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset code' }))

    expect(await screen.findByLabelText('Verification code')).toBeInTheDocument()
    expect(startPasswordReset).toHaveBeenCalledWith('user@example.com')

    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'New-password-2026!' } })
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'New-password-2026!' } })
    fireEvent.click(screen.getByRole('button', { name: 'Update password' }))

    await waitFor(() =>
      expect(confirmPasswordReset).toHaveBeenCalledWith(
        'user@example.com',
        '123456',
        'New-password-2026!',
      ),
    )
    expect(await screen.findByText('Your password has been changed. You can now sign in with your new password.')).toBeInTheDocument()
  })

  it('keeps the legacy SMTP reset flow available outside Cognito mode', async () => {
    const { apiFetch } = await import('../api')
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'sent' }),
    })
    render(<ForgotPasswordForm onBack={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'legacy@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset code' }))

    expect(await screen.findByText(/password reset instructions have been sent/i)).toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledWith('/auth/forgot-password', expect.objectContaining({
      method: 'POST',
    }))
  })
})
