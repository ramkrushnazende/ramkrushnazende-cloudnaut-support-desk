import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({ apiFetch: vi.fn() }))
vi.mock('../cognito/cognitoAuth', () => ({
  AuthStatus: {
    SUCCESS: 'SUCCESS',
    MFA_REQUIRED: 'MFA_REQUIRED',
    MFA_SETUP_REQUIRED: 'MFA_SETUP_REQUIRED',
    NEW_PASSWORD_REQUIRED: 'NEW_PASSWORD_REQUIRED',
  },
  associateTotp: vi.fn(),
  completeNewPassword: vi.fn(),
  confirmSignUp: vi.fn(),
  resendSignUpCode: vi.fn(),
  respondToMfaChallenge: vi.fn(),
  signIn: vi.fn(),
  signUp: vi.fn(),
  verifyTotp: vi.fn(),
}))

import { apiFetch } from '../api'
import {
  AuthStatus,
  confirmSignUp,
  respondToMfaChallenge,
  signIn,
  signUp,
} from '../cognito/cognitoAuth'
import SignupForm from './SignupForm'

afterEach(() => vi.clearAllMocks())

describe('SignupForm Cognito onboarding', () => {
  it('submits the final token after email confirmation and MFA, without trusting browser identity fields', async () => {
    signUp.mockResolvedValue({ userConfirmed: false })
    confirmSignUp.mockResolvedValue(undefined)
    signIn.mockResolvedValue({
      status: AuthStatus.MFA_REQUIRED,
      user: { Username: 'staff@example.com' },
      challengeName: 'SOFTWARE_TOKEN_MFA',
    })
    respondToMfaChallenge.mockResolvedValue({
      status: AuthStatus.SUCCESS,
      tokens: { accessToken: 'final-cognito-access-token' },
    })
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 1, status: 'pending' }),
    })

    render(<SignupForm initialRole="employee" onBackToLogin={vi.fn()} onForgotPassword={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Staff User' } })
    fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'staff@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Strong!Pass1234' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register' }))

    await screen.findByText(/Enter the verification code/i)
    fireEvent.change(screen.getByLabelText('Email verification code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify email' }))
    await screen.findByText(/Sign in to securely link this request/i)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in and continue' }))

    await screen.findByText(/Enter the current code from your authenticator app/i)
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/auth/signup', {
        method: 'POST',
        authToken: 'final-cognito-access-token',
        body: JSON.stringify({ role: 'employee', message: '' }),
      })
    })
    expect(signUp).toHaveBeenCalledWith('staff@example.com', 'Strong!Pass1234', 'Staff User')
    expect(signIn).toHaveBeenCalledWith('staff@example.com', 'Strong!Pass1234')
    expect(respondToMfaChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ Username: 'staff@example.com' }),
      '654321',
      'SOFTWARE_TOKEN_MFA',
    )
    expect(await screen.findByText(/pending Admin approval/i)).toBeInTheDocument()
  })
})
