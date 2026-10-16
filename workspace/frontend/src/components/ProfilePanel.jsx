import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { apiFetch } from '../api'

import {
  updatePhoneNumber,
  sendPhoneVerificationCode,
  confirmPhoneNumber,
  setupTotp,
  confirmTotpSetup,
  disableTotp,
  changePassword,
} from '../cognito/cognitoAuth'

// Account/profile panel. Shows the DB-authoritative identity (name, email,
// role, phone, MFA status) and lets the signed-in user manage their phone
// number and TOTP authenticator. Role is read-only here — it is managed by
// admins in PostgreSQL and never editable via Cognito attributes.
function ProfilePanel({ user, onClose, onPhoneVerified }) {
  const [phone, setPhone] = useState(user?.phone_number || '')
  const [savedPhone, setSavedPhone] = useState(user?.phone_number || '')
  const [mfaEnabled, setMfaEnabled] = useState(Boolean(user?.mfa_enabled))
  const [mfaStatusLoading, setMfaStatusLoading] = useState(true)
  const [phoneCode, setPhoneCode] = useState('')
  const [phoneStep, setPhoneStep] = useState('idle') // idle | codeSent | verified
  const [totpStep, setTotpStep] = useState('idle') // idle | enrolling
  const [totpCode, setTotpCode] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [manualSecret, setManualSecret] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    apiFetch('/profile/mfa', { method: 'POST' })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok || typeof data.mfa_enabled !== 'boolean') {
          throw new Error(data.detail || 'Could not confirm authenticator status.')
        }
        if (active) {
          setMfaEnabled(data.mfa_enabled)
        }
      })
      .catch((statusError) => {
        if (active) setError(statusError.message || 'Could not confirm authenticator status.')
      })
      .finally(() => {
        if (active) setMfaStatusLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const run = async (fn) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await fn()
    } catch (err) {
      setError(err.message || 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const savePhone = () =>
    run(async () => {
      if (!/^\+[1-9]\d{7,14}$/.test(phone.trim())) {
        throw new Error('Enter a valid phone number in international format, such as +911234567890.')
      }
      await updatePhoneNumber(phone.trim())
      await sendPhoneVerificationCode()
      setPhoneStep('codeSent')
      setNotice('We sent a verification code to your phone.')
    })

  const persistVerifiedPhone = async () => {
    const response = await apiFetch('/profile/phone', { method: 'POST' })
    const data = await response.json()
    if (!response.ok) throw new Error(data.detail || 'Could not save the verified phone number.')
    setSavedPhone(data.phone_number)
    setPhone(data.phone_number)
    setPhoneCode('')
    setPhoneStep('idle')
    onPhoneVerified?.(data.phone_number)
    setNotice('Phone number verified and saved.')
  }

  const verifyPhone = () =>
    run(async () => {
      await confirmPhoneNumber(phoneCode.trim())
      setPhoneStep('verified')
      await persistVerifiedPhone()
    })

  const retryPhoneSave = () =>
    run(async () => {
      await persistVerifiedPhone()
    })

  const syncMfaStatus = async () => {
    const response = await apiFetch('/profile/mfa', { method: 'POST' })
    const data = await response.json()
    if (!response.ok || typeof data.mfa_enabled !== 'boolean') {
      throw new Error(data.detail || 'Could not confirm authenticator status.')
    }
    setMfaEnabled(data.mfa_enabled)
    return data.mfa_enabled
  }

  const startTotp = () =>
    run(async () => {
      const { otpauthUri, secretCode } = await setupTotp({ accountLabel: user?.email })
      setManualSecret(secretCode)
      setQrDataUrl(await QRCode.toDataURL(otpauthUri))
      setTotpStep('enrolling')
    })

  const finishTotp = () =>
    run(async () => {
      await confirmTotpSetup(totpCode.trim())
      const enabled = await syncMfaStatus()
      setTotpStep('idle')
      setTotpCode('')
      setQrDataUrl('')
      setManualSecret('')
      setNotice(enabled ? 'Authenticator enabled.' : 'Authenticator is not enabled. Please try again.')
    })

  const resetTotp = () =>
    run(async () => {
      await disableTotp()
      const enabled = await syncMfaStatus()
      setNotice(enabled
        ? 'Authenticator remains enabled. Set up a new one to replace it.'
        : 'Authenticator disabled. Set up a new one to re-enable MFA.')
    })

  const updatePassword = () =>
    run(async () => {
      if (newPassword !== confirmPassword) throw new Error('New passwords do not match.')
      if (currentPassword === newPassword) throw new Error('Choose a password different from your current password.')
      await changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setNotice('Your password has been changed.')
    })

  const displayName = user?.name || user?.email || 'Account'
  const initials = displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()

  return (
    <section className="ticket-form-card auth-card profile-panel">
      <span className="section-label">ACCOUNT</span>
      <div className="profile-layout">
        <aside className="profile-summary">
          <div className="profile-heading">
            <div className="profile-avatar" aria-label={`${displayName} profile picture`} role="img">
              {initials}
            </div>
            <div className="profile-heading-copy">
              <h2>Your profile</h2>
              <p>{displayName}</p>
              <span className="profile-role">{user?.role || 'Member'}</span>
            </div>
          </div>

          <dl className="profile-fields">
            <div><dt>Name</dt><dd>{user?.name || '—'}</dd></div>
            <div><dt>Email</dt><dd>{user?.email || '—'}</dd></div>
            <div><dt>Role</dt><dd>{user?.role || '—'}</dd></div>
            <div><dt>Phone</dt><dd>{savedPhone || 'Not set'}</dd></div>
            <div>
              <dt>Two-factor (TOTP)</dt>
              <dd>{mfaStatusLoading ? 'Checking…' : mfaEnabled ? 'Enabled' : 'Not enabled'}</dd>
            </div>
          </dl>
        </aside>

        <div className="profile-settings">
          {notice && <p className="team-notice" role="status">{notice}</p>}
          {error && <div className="error-box"><strong>Action failed</strong><span>{error}</span></div>}

          <form
            className="profile-setting-card"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault()
              savePhone()
            }}
          >
            <h3 id="profile-phone-heading">Phone number</h3>
            <div className="form-group">
              <label htmlFor="profile-phone">Phone (E.164, e.g. +9112345xxxxx)</label>
              <input id="profile-phone" name="profile-phone-number" type="tel" autoComplete="off" value={phone}
                     onChange={(e) => setPhone(e.target.value)} />
            </div>
            <button type="submit" className="submit-button" disabled={busy}>
              Save &amp; send code
            </button>
            {phoneStep === 'codeSent' && (
              <div className="profile-verify">
                <div className="form-group">
                  <label htmlFor="phone-code">Verification code</label>
                  <input id="phone-code" autoComplete="one-time-code" inputMode="numeric" value={phoneCode}
                         onChange={(e) => setPhoneCode(e.target.value)} />
                </div>
                <button type="button" className="submit-button" disabled={busy} onClick={verifyPhone}>
                  Verify phone
                </button>
              </div>
            )}
            {phoneStep === 'verified' && (
              <button type="button" className="submit-button" disabled={busy} onClick={retryPhoneSave}>
                Retry saving verified phone
              </button>
            )}
          </form>

          <form
            className="profile-setting-card"
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault()
              updatePassword()
            }}
          >
            <h3 id="profile-password-heading">Change password</h3>
            <div className="form-group">
              <label htmlFor="profile-current-password">Current password</label>
              <input id="profile-current-password" name="profile-current-password" type="password" autoComplete="new-password"
                     value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="profile-new-password">New password</label>
              <input id="profile-new-password" type="password" autoComplete="new-password"
                     minLength="12" maxLength="200" value={newPassword}
                     onChange={(event) => setNewPassword(event.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="profile-confirm-password">Confirm new password</label>
              <input id="profile-confirm-password" type="password" autoComplete="new-password"
                     minLength="12" maxLength="200" value={confirmPassword}
                     onChange={(event) => setConfirmPassword(event.target.value)} />
            </div>
            <button type="submit" className="submit-button" disabled={busy || !currentPassword || !newPassword || !confirmPassword}>
              Change password
            </button>
          </form>

          <section className="profile-setting-card">
            <h3 id="profile-totp-heading">Authenticator (TOTP)</h3>
            {totpStep === 'idle' ? (
              <div className="profile-totp-actions">
                <button type="button" className="submit-button" disabled={busy || mfaStatusLoading} onClick={startTotp}>
                  {mfaStatusLoading ? 'Checking authenticator…' : mfaEnabled ? 'Reset authenticator' : 'Set up authenticator'}
                </button>
                {mfaEnabled && !mfaStatusLoading && (
                  <button type="button" className="secondary-button" disabled={busy} onClick={resetTotp}>
                    Disable authenticator
                  </button>
                )}
              </div>
            ) : (
              <div className="profile-totp-enroll">
                <p>Scan with Google Authenticator or Microsoft Authenticator, then enter the code.</p>
                {qrDataUrl && <img src={qrDataUrl} alt="Authenticator QR code" width="180" height="180" />}
                <p className="mfa-manual">Can’t scan? Key: <code>{manualSecret}</code></p>
                <div className="form-group">
                  <label htmlFor="totp-code">Code from your app</label>
                  <input id="totp-code" inputMode="numeric" maxLength="6" value={totpCode}
                         onChange={(e) => setTotpCode(e.target.value)} />
                </div>
                <button type="button" className="submit-button" disabled={busy} onClick={finishTotp}>
                  Confirm authenticator
                </button>
              </div>
            )}
          </section>
        </div>
      </div>

      {onClose && (
        <button type="button" className="secondary-button" onClick={onClose}>Back</button>
      )}
    </section>
  )
}

export default ProfilePanel
