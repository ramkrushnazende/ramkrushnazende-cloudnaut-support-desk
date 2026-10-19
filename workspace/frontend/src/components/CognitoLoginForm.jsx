import { useState } from 'react'
import QRCode from 'qrcode'

import {
  AuthStatus,
  signIn,
  respondToMfaChallenge,
  associateTotp,
  verifyTotp,
  completeNewPassword,
  getAccessToken,
} from '../cognito/cognitoAuth'
import { resolveIdentity } from '../cognito/session'

// Multi-step Cognito sign-in:
//   password -> (mfa | mfaSetup) -> resolve DB identity -> onLogin
// Role is resolved from PostgreSQL via the backend; never from the token.
const STEP = {
  PASSWORD: 'password',
  MFA: 'mfa',
  MFA_SETUP: 'mfaSetup',
  NEW_PASSWORD: 'newPassword',
}

const roleNames = {
  employee: 'Staff',
  support: 'Support Team',
  admin: 'Admin',
}

function CognitoLoginForm({ onLogin, onBackToRoles, onSignUp, onForgotPassword, selectedRole }) {
  const [step, setStep] = useState(STEP.PASSWORD)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [code, setCode] = useState('')
  const [cognitoUser, setCognitoUser] = useState(null)
  const [mfaChallenge, setMfaChallenge] = useState('SOFTWARE_TOKEN_MFA')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [manualSecret, setManualSecret] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // After Cognito reports SUCCESS, resolve the DB identity and hand the app a
  // login payload shaped exactly like the legacy flow ({access_token, user}).
  // Prefer the access token the SDK just produced in its challenge onSuccess
  // callback: amazon-cognito-identity-js does NOT reliably persist the session
  // to storage immediately after completeNewPasswordChallenge / MFA, so a fresh
  // getCurrentUser().getSession() can return null and cause a false
  // "Session expired". Fall back to getAccessToken() only if no token was
  // threaded through (e.g. session restore on reload).
  const finishLogin = async (result) => {
    const accessToken = result?.tokens?.accessToken || (await getAccessToken())
    if (!accessToken) {
      throw new Error('Could not establish a session. Please sign in again.')
    }
    const user = await resolveIdentity(accessToken)
    // Role selection is a UI preference only. The authoritative role comes from
    // the backend (user.role). If the signed-in account's real role differs
    // from the one the user picked, show a friendly message instead of logging
    // in under the wrong "view" — this does NOT grant any permission (the
    // backend always enforces the real role).
    if (selectedRole && user.role !== selectedRole) {
      throw new Error(
        `This account is registered as ${roleNames[user.role] || user.role}. ` +
        `Choose that option on the previous screen to continue.`,
      )
    }
    onLogin({ access_token: accessToken, user })
  }

  // Dispatch a signIn()/completeNewPassword() result to the right next step.
  const handleResult = async (result) => {
    if (result.status === AuthStatus.SUCCESS) {
      await finishLogin(result)
    } else if (result.status === AuthStatus.MFA_REQUIRED) {
      setCognitoUser(result.user)
      setMfaChallenge(result.challengeName || 'SOFTWARE_TOKEN_MFA')
      setStep(STEP.MFA)
    } else if (result.status === AuthStatus.MFA_SETUP_REQUIRED) {
      setCognitoUser(result.user)
      const { otpauthUri, secretCode } = await associateTotp(result.user, { accountLabel: email })
      setManualSecret(secretCode)
      setQrDataUrl(await QRCode.toDataURL(otpauthUri))
      setStep(STEP.MFA_SETUP)
    } else if (result.status === AuthStatus.NEW_PASSWORD_REQUIRED) {
      setCognitoUser(result.user)
      setStep(STEP.NEW_PASSWORD)
    }
  }

  const handlePassword = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await handleResult(await signIn(email, password))
    } catch (err) {
      setError(err.message || 'Could not sign in.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleNewPassword = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await handleResult(await completeNewPassword(cognitoUser, newPassword))
    } catch (err) {
      setError(err.message || 'Could not set your new password.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleMfa = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await respondToMfaChallenge(cognitoUser, code.trim(), mfaChallenge)
      await finishLogin(result)
    } catch (err) {
      setError(err.message || 'Could not verify the code.')
    } finally {
      setSubmitting(false)
    }
  }

  const handleMfaSetup = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await verifyTotp(cognitoUser, code.trim())
      // Enrollment complete and TOTP set as preferred; the SDK session is now
      // authenticated. Prefer the token from the result; finishLogin falls back
      // to getAccessToken() if the setup path didn't surface a session.
      await finishLogin(result)
    } catch (err) {
      setError(err.message || 'Could not complete authenticator setup.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="ticket-form-card auth-card">
      <span className="section-label">SECURE ACCESS</span>

      {step === STEP.PASSWORD && (
        <>
          <h2>Sign in</h2>
          <p>Use the email address from your Cognito invitation. You may be asked for an authenticator code.</p>
          <form className="ticket-form" onSubmit={handlePassword}>
            <div className="form-group">
              <label htmlFor="cognito-email">Work email</label>
              <input id="cognito-email" type="text" autoComplete="username" required
                     value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="cognito-password">Password</label>
              <input id="cognito-password" type="password" autoComplete="current-password" required
                     value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <div className="error-box"><strong>Unable to sign in</strong><span>{error}</span></div>}
            <button type="submit" className="submit-button" disabled={submitting}>
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>
            {onSignUp && selectedRole !== 'admin' && (
              <p className="auth-signup-prompt">
                Need an account?{' '}
                <button type="button" className="auth-link" onClick={onSignUp}>
                  Register for access
                </button>
              </p>
            )}
            {onForgotPassword && (
              <p className="auth-signup-prompt">
                <button type="button" className="auth-link" onClick={onForgotPassword}>Forgot password?</button>
              </p>
            )}
            {onBackToRoles && (
              <button type="button" className="secondary-button" onClick={onBackToRoles}>Back</button>
            )}
          </form>
        </>
      )}

      {step === STEP.NEW_PASSWORD && (
        <>
          <h2>Set a new password</h2>
          <p>Your account requires a new password to finish setup.</p>
          <form className="ticket-form" onSubmit={handleNewPassword}>
            <div className="form-group">
              <label htmlFor="new-password">New password</label>
              <input id="new-password" type="password" autoComplete="new-password"
                     minLength="12" required
                     value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </div>
            {error && <div className="error-box"><strong>Could not set password</strong><span>{error}</span></div>}
            <button type="submit" className="submit-button" disabled={submitting}>
              {submitting ? 'Saving...' : 'Set password'}
            </button>
          </form>
        </>
      )}

      {step === STEP.MFA && (
        <>
          <h2>{mfaChallenge === 'SMS_MFA' ? 'Enter your SMS code' : 'Enter your authenticator code'}</h2>
          <p>{mfaChallenge === 'SMS_MFA'
            ? 'Enter the 6-digit code sent to your phone.'
            : 'Open your authenticator app and enter the current 6-digit code.'}</p>
          <form className="ticket-form" onSubmit={handleMfa}>
            <div className="form-group">
              <label htmlFor="mfa-code">Authentication code</label>
              <input id="mfa-code" inputMode="numeric" autoComplete="one-time-code"
                     pattern="[0-9]*" maxLength="6" required
                     value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            {error && <div className="error-box"><strong>Verification failed</strong><span>{error}</span></div>}
            <button type="submit" className="submit-button" disabled={submitting}>
              {submitting ? 'Verifying...' : 'Verify'}
            </button>
          </form>
        </>
      )}

      {step === STEP.MFA_SETUP && (
        <>
          <h2>Set up two-factor authentication</h2>
          <p>Scan this QR code with Google Authenticator or Microsoft Authenticator, then enter the 6-digit code to finish.</p>
          {qrDataUrl && <img src={qrDataUrl} alt="Authenticator QR code" className="mfa-qr" width="180" height="180" />}
          <p className="mfa-manual">
            Can’t scan? Enter this key manually:<br />
            <code>{manualSecret}</code>
          </p>
          <form className="ticket-form" onSubmit={handleMfaSetup}>
            <div className="form-group">
              <label htmlFor="setup-code">Code from your app</label>
              <input id="setup-code" inputMode="numeric" autoComplete="one-time-code"
                     pattern="[0-9]*" maxLength="6" required
                     value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
            {error && <div className="error-box"><strong>Setup failed</strong><span>{error}</span></div>}
            <button type="submit" className="submit-button" disabled={submitting}>
              {submitting ? 'Finishing...' : 'Confirm & finish'}
            </button>
          </form>
        </>
      )}
    </section>
  )
}

export default CognitoLoginForm
