import { useState } from 'react'
import { apiFetch } from '../api'
import { confirmPasswordReset, startPasswordReset } from '../cognito/cognitoAuth'

function ForgotPasswordForm({ onBack, cognitoMode = false }) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [stage, setStage] = useState('request')
  const submitted = stage === 'sent' || stage === 'legacy-sent' || stage === 'complete'

  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      if (cognitoMode && stage === 'sent' && password !== confirmPassword) {
        throw new Error('Passwords do not match.')
      }
      if (cognitoMode && stage === 'sent') {
        await confirmPasswordReset(email, code, password)
        setStage('complete')
      } else if (cognitoMode) {
        await startPasswordReset(email)
        setStage('sent')
      } else {
        const response = await apiFetch('/auth/forgot-password', {
          method: 'POST',
          body: JSON.stringify({ email }),
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.detail || 'Could not request a password reset.')
        setStage('legacy-sent')
      }
    } catch (requestError) {
      setError(requestError.message || 'Could not connect to the service.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="ticket-form-card auth-card">
      <span className="section-label">PASSWORD RECOVERY</span>
      <h2>{stage === 'complete' ? 'Password updated' : submitted ? 'Check your email' : 'Forgot password?'}</h2>
      {stage === 'complete' ? (
        <>
          <p>Your password has been changed. You can now sign in with your new password.</p>
          <button type="button" className="secondary-button" onClick={onBack}>Back to sign in</button>
        </>
      ) : stage === 'legacy-sent' ? (
        <>
          <p>If an active account uses that email, password reset instructions have been sent.</p>
          <button type="button" className="secondary-button" onClick={onBack}>Back to sign in</button>
        </>
      ) : (
        <form className="ticket-form" onSubmit={handleSubmit}>
          <p>{stage === 'sent'
            ? 'Enter the verification code sent to your email and choose a new password.'
            : cognitoMode
              ? 'Enter your account email and Cognito will send a verification code.'
              : 'Enter your account email and we’ll send a password reset link.'}</p>
          <div className="form-group">
            <label htmlFor="forgot-email">Work email</label>
            <input id="forgot-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          {stage === 'sent' && (
            <>
              <div className="form-group">
                <label htmlFor="reset-code">Verification code</label>
                <input id="reset-code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value)} />
              </div>
              <div className="form-group">
                <label htmlFor="reset-password">New password</label>
                <input id="reset-password" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
              <div className="form-group">
                <label htmlFor="reset-confirm-password">Confirm new password</label>
                <input id="reset-confirm-password" type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              </div>
            </>
          )}
          {error && <div className="error-box"><strong>Unable to request reset</strong><span>{error}</span></div>}
          <button type="submit" className="submit-button" disabled={submitting}>
            {submitting ? (stage === 'sent' ? 'Updating...' : 'Sending...') : stage === 'sent' ? 'Update password' : 'Send reset code'}
          </button>
          <button type="button" className="secondary-button" onClick={onBack}>Back to sign in</button>
        </form>
      )}
    </section>
  )
}

export default ForgotPasswordForm