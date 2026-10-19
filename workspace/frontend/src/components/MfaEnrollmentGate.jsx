import { useState } from 'react'
import QRCode from 'qrcode'

import { confirmTotpSetup, setupTotp } from '../cognito/cognitoAuth'

function MfaEnrollmentGate({ user, onComplete, onSignOut }) {
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [manualSecret, setManualSecret] = useState('')
  const [code, setCode] = useState('')
  const [started, setStarted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const startEnrollment = async () => {
    setBusy(true)
    setError('')
    try {
      const { otpauthUri, secretCode } = await setupTotp({ accountLabel: user?.email })
      setManualSecret(secretCode)
      setQrDataUrl(await QRCode.toDataURL(otpauthUri))
      setStarted(true)
    } catch (enrollmentError) {
      setError(enrollmentError.message || 'Could not start MFA enrollment.')
    } finally {
      setBusy(false)
    }
  }

  const finishEnrollment = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await confirmTotpSetup(code.trim())
      await onComplete()
    } catch (enrollmentError) {
      setError(enrollmentError.message || 'The authenticator code could not be verified.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="ticket-form-card auth-card mfa-enrollment-gate">
      <span className="section-label">SECURITY CHECK</span>
      <h2>Set up MFA to continue</h2>
      <p>
        Your administrator requires an authenticator app for employee and support accounts.
        Complete setup before opening support tickets or staff data.
      </p>

      {!started ? (
        <button type="button" className="submit-button" onClick={startEnrollment} disabled={busy}>
          {busy ? 'Preparing authenticator…' : 'Set up authenticator'}
        </button>
      ) : (
        <form className="ticket-form" onSubmit={finishEnrollment}>
          {qrDataUrl && <img src={qrDataUrl} alt="Authenticator QR code" className="mfa-qr" width="180" height="180" />}
          <p className="mfa-manual">
            Can’t scan? Enter this key manually:<br />
            <code>{manualSecret}</code>
          </p>
          <div className="form-group">
            <label htmlFor="required-mfa-code">Code from your authenticator</label>
            <input
              id="required-mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength="6"
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          {error && <div className="error-box"><strong>Enrollment failed</strong><span>{error}</span></div>}
          <button type="submit" className="submit-button" disabled={busy}>
            {busy ? 'Verifying…' : 'Verify and continue'}
          </button>
        </form>
      )}

      {!started && error && <div className="error-box"><strong>Enrollment unavailable</strong><span>{error}</span></div>}
      <button type="button" className="secondary-button mfa-signout-button" onClick={onSignOut} disabled={busy}>
        Sign out
      </button>
    </section>
  )
}

export default MfaEnrollmentGate
