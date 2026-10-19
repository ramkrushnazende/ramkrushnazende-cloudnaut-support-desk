import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../cognito/cognitoAuth', () => ({
  setupTotp: vi.fn().mockResolvedValue({
    otpauthUri: 'otpauth://totp/test',
    secretCode: 'SECRET123',
  }),
  confirmTotpSetup: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
}))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,QR') } }))

import { confirmTotpSetup, setupTotp } from '../cognito/cognitoAuth'
import MfaEnrollmentGate from './MfaEnrollmentGate'

describe('MfaEnrollmentGate', () => {
  it('enrolls a required staff member with QR/TOTP and refreshes access', async () => {
    const onComplete = vi.fn().mockResolvedValue(undefined)
    render(<MfaEnrollmentGate user={{ email: 'staff@example.com' }} onComplete={onComplete} onSignOut={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /set up authenticator/i }))
    expect(await screen.findByAltText('Authenticator QR code')).toBeInTheDocument()
    expect(screen.getByText('SECRET123')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Code from your authenticator'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: /verify and continue/i }))

    await waitFor(() => expect(confirmTotpSetup).toHaveBeenCalledWith('123456'))
    expect(setupTotp).toHaveBeenCalledWith({ accountLabel: 'staff@example.com' })
    expect(onComplete).toHaveBeenCalled()
  })
})
