import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  AuthStatus,
  signUp,
  confirmSignUp,
  resendSignUpCode,
  signIn,
  respondToMfaChallenge,
  associateTotp,
  verifyTotp,
  completeNewPassword,
  changePassword,
  updatePhoneNumber,
  sendPhoneVerificationCode,
  confirmPhoneNumber,
  setupTotp,
  confirmTotpSetup,
  disableTotp,
  getAccessToken,
  signOut,
  __setSdk,
  __resetSdk,
} from './cognitoAuth'

// ---------------------------------------------------------------------------
// Fake amazon-cognito-identity-js SDK. Each test configures the behaviour the
// fake CognitoUser should exhibit via `user._behaviour`.
// ---------------------------------------------------------------------------
function fakeSession(prefix = 'tok') {
  return {
    getAccessToken: () => ({ getJwtToken: () => `${prefix}-access` }),
    getIdToken: () => ({ getJwtToken: () => `${prefix}-id` }),
    isValid: () => true,
  }
}

class FakeAuthenticationDetails {
  constructor(opts) {
    this.opts = opts
  }
}

class FakeCognitoUserAttribute {
  constructor(value) {
    Object.assign(this, value)
  }
}

let currentUser = null // what the pool's getCurrentUser() returns

class FakeCognitoUser {
  constructor({ Username }) {
    this.Username = Username
    this._behaviour = behaviour // closure set per test
    behaviour.lastUser = this
  }

  authenticateUser(_authDetails, cbs) {
    const b = this._behaviour
    if (b.auth === 'success') return cbs.onSuccess(fakeSession())
    if (b.auth === 'totp') return cbs.totpRequired('SOFTWARE_TOKEN_MFA')
    if (b.auth === 'sms') return cbs.mfaRequired('SMS_MFA')
    if (b.auth === 'mfaSetup') return cbs.mfaSetup()
    if (b.auth === 'newPassword') return cbs.newPasswordRequired()
    return cbs.onFailure({ code: b.authError || 'NotAuthorizedException' })
  }

  confirmRegistration(code, forceAliasCreation, cb) {
    this._behaviour.confirmationCode = code
    this._behaviour.forceAliasCreation = forceAliasCreation
    cb(this._behaviour.confirmFail ? { code: 'CodeMismatchException' } : null)
  }

  resendConfirmationCode(cb) {
    cb(this._behaviour.resendFail ? { code: 'LimitExceededException' } : null)
  }

  sendMFACode(code, cbs, mfaType) {
    this._behaviour.lastMfaType = mfaType
    if (code === this._behaviour.validCode) return cbs.onSuccess(fakeSession('mfa'))
    return cbs.onFailure({ code: 'CodeMismatchException' })
  }

  associateSoftwareToken(cbs) {
    if (this._behaviour.associateFail) return cbs.onFailure({ code: 'InternalErrorException' })
    return cbs.associateSecretCode('SECRET123')
  }

  verifySoftwareToken(code, _name, cbs) {
    if (code !== this._behaviour.validCode) return cbs.onFailure({ code: 'CodeMismatchException' })
    if (this._behaviour.auth === 'mfaSetup') return cbs.onSuccess(fakeSession('setup'))
    return cbs.onSuccess({ status: 'SUCCESS' })
  }

  setUserMfaPreference(_sms, _totp, cb) {
    cb(this._behaviour.prefFail ? { code: 'InternalErrorException' } : null)
  }

  changePassword(currentPassword, newPassword, cb) {
    this._behaviour.passwordChange = { currentPassword, newPassword }
    cb(this._behaviour.passwordChangeError || null)
  }

  getSession(cb) {
    if (this._behaviour.sessionInvalid) return cb(new Error('invalid'), null)
    return cb(null, fakeSession('refreshed'))
  }

  signOut() {
    this._behaviour.signedOut = true
  }

  completeNewPasswordChallenge(_pw, _attrs, cbs) {
    if (this._behaviour.newPwFail) return cbs.onFailure({ code: 'InvalidPasswordException' })
    if (this._behaviour.newPwThenMfa) return cbs.totpRequired('SOFTWARE_TOKEN_MFA')
    return cbs.onSuccess(fakeSession('newpw'))
  }

  updateAttributes(_attrs, cb) {
    cb(this._behaviour.updateFail ? { code: 'InvalidParameterException' } : null)
  }

  getAttributeVerificationCode(_name, cbs) {
    if (this._behaviour.sendCodeFail) {
      return cbs.onFailure({ code: this._behaviour.sendCodeError || 'LimitExceededException' })
    }
    return cbs.onSuccess()
  }

  verifyAttribute(_name, code, cbs) {
    if (code !== this._behaviour.validCode) return cbs.onFailure({ code: 'CodeMismatchException' })
    return cbs.onSuccess()
  }
}

class FakeCognitoUserPool {
  constructor(opts) {
    this.opts = opts
  }

  getCurrentUser() {
    return currentUser
  }

  signUp(username, _password, attributes, _validationData, cb) {
    behaviour.signUpCall = { username, attributes }
    if (behaviour.signUpFail) return cb({ code: 'InvalidPasswordException' })
    cb(null, { userConfirmed: false })
  }
}

let behaviour = {}

beforeEach(() => {
  behaviour = { validCode: '123456' }
  currentUser = null
  vi.stubEnv('VITE_COGNITO_USER_POOL_ID', 'ap-south-1_Test123')
  vi.stubEnv('VITE_COGNITO_APP_CLIENT_ID', 'test-client-id')
  vi.stubEnv('VITE_AWS_REGION', 'ap-south-1')
  __setSdk({
    CognitoUserPool: FakeCognitoUserPool,
    CognitoUser: FakeCognitoUser,
    AuthenticationDetails: FakeAuthenticationDetails,
    CognitoUserAttribute: FakeCognitoUserAttribute,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  __resetSdk()
})

describe('public Cognito registration', () => {
  it('signs up with email and name attributes without exposing Cognito details', async () => {
    await expect(signUp('New@Example.com', 'VerySecure!Pass123', 'New User')).resolves.toEqual({
      userConfirmed: false,
    })
    expect(behaviour.signUpCall.username).toBe('new@example.com')
    expect(behaviour.signUpCall.attributes.map(({ Name, Value }) => [Name, Value])).toEqual([
      ['email', 'new@example.com'],
      ['name', 'New User'],
    ])
  })

  it('confirms and can resend the email verification code', async () => {
    await expect(confirmSignUp('new@example.com', '123456')).resolves.toBeUndefined()
    expect(behaviour.lastUser._behaviour.confirmationCode).toBe('123456')
    expect(behaviour.lastUser._behaviour.forceAliasCreation).toBe(false)
    await expect(resendSignUpCode('new@example.com')).resolves.toBeUndefined()
  })

  it('converts Cognito registration failures to safe messages', async () => {
    behaviour.signUpFail = true
    await expect(signUp('new@example.com', 'bad', 'New User')).rejects.toThrow(
      'Something went wrong. Please try again.',
    )
    expect(behaviour.signUpCall.username).toBe('new@example.com')
  })
})

// ---------------------------------------------------------------------------
// signIn
// ---------------------------------------------------------------------------
describe('signIn', () => {
  it('returns SUCCESS with an access token on a clean login', async () => {
    behaviour.auth = 'success'
    const result = await signIn('a@x.com', 'pw')
    expect(result.status).toBe(AuthStatus.SUCCESS)
    expect(result.tokens.accessToken).toBe('tok-access')
  })

  it('returns MFA_REQUIRED when a TOTP challenge is raised', async () => {
    behaviour.auth = 'totp'
    const result = await signIn('a@x.com', 'pw')
    expect(result.status).toBe(AuthStatus.MFA_REQUIRED)
    expect(result.challengeName).toBe('SOFTWARE_TOKEN_MFA')
    expect(result.user).toBeTruthy()
  })

  it('supports the SMS_MFA challenge callback when Cognito returns it', async () => {
    behaviour.auth = 'sms'
    const result = await signIn('a@x.com', 'pw')
    expect(result.status).toBe(AuthStatus.MFA_REQUIRED)
    expect(result.challengeName).toBe('SMS_MFA')
    await respondToMfaChallenge(result.user, '123456', result.challengeName)
    expect(result.user._behaviour.lastMfaType).toBe('SMS_MFA')
  })

  it('returns MFA_SETUP_REQUIRED when the user must enroll TOTP first', async () => {
    behaviour.auth = 'mfaSetup'
    const result = await signIn('a@x.com', 'pw')
    expect(result.status).toBe(AuthStatus.MFA_SETUP_REQUIRED)
  })

  it('returns NEW_PASSWORD_REQUIRED for an invited user', async () => {
    behaviour.auth = 'newPassword'
    const result = await signIn('a@x.com', 'pw')
    expect(result.status).toBe(AuthStatus.NEW_PASSWORD_REQUIRED)
  })

  it('rejects wrong credentials with a non-enumerating message', async () => {
    behaviour.auth = 'fail'
    behaviour.authError = 'NotAuthorizedException'
    await expect(signIn('a@x.com', 'bad')).rejects.toThrow('Email or password is incorrect.')
  })

  it('maps an unknown user to the same generic message (no enumeration)', async () => {
    behaviour.auth = 'fail'
    behaviour.authError = 'UserNotFoundException'
    await expect(signIn('nobody@x.com', 'pw')).rejects.toThrow('Email or password is incorrect.')
  })

  it('throws when Cognito is not configured', () => {
    vi.stubEnv('VITE_COGNITO_USER_POOL_ID', '')
    // buildUserPool throws synchronously before a Promise is created.
    expect(() => signIn('a@x.com', 'pw')).toThrow('Cognito is not configured.')
  })
})

// ---------------------------------------------------------------------------
// MFA challenge
// ---------------------------------------------------------------------------
describe('respondToMfaChallenge', () => {
  it('returns SUCCESS for a correct TOTP code', async () => {
    behaviour.auth = 'totp'
    const { user } = await signIn('a@x.com', 'pw')
    const result = await respondToMfaChallenge(user, '123456')
    expect(result.status).toBe(AuthStatus.SUCCESS)
    expect(result.tokens.accessToken).toBe('mfa-access')
  })

  it('rejects an incorrect TOTP code', async () => {
    behaviour.auth = 'totp'
    const { user } = await signIn('a@x.com', 'pw')
    await expect(respondToMfaChallenge(user, '000000')).rejects.toThrow('That code is incorrect. Try again.')
  })
})

// ---------------------------------------------------------------------------
// TOTP enrollment
// ---------------------------------------------------------------------------
describe('associateTotp / verifyTotp', () => {
  it('returns a secret and an otpauth URI for the QR code', async () => {
    behaviour.auth = 'mfaSetup'
    const { user } = await signIn('a@x.com', 'pw')
    const { secretCode, otpauthUri } = await associateTotp(user, { accountLabel: 'a@x.com' })
    expect(secretCode).toBe('SECRET123')
    expect(otpauthUri).toContain('otpauth://totp/')
    expect(otpauthUri).toContain('secret=SECRET123')
    expect(otpauthUri).toContain('issuer=Cloudnaut%20Support%20Desk')
  })

  it('completes enrollment on a correct verify code', async () => {
    behaviour.auth = 'mfaSetup'
    const { user } = await signIn('a@x.com', 'pw')
    const result = await verifyTotp(user, '123456')
    expect(result.status).toBe(AuthStatus.SUCCESS)
    expect(result.tokens.accessToken).toBe('setup-access')
  })

  it('rejects a wrong verify code', async () => {
    behaviour.auth = 'mfaSetup'
    const { user } = await signIn('a@x.com', 'pw')
    await expect(verifyTotp(user, '999999')).rejects.toThrow('That code is incorrect. Try again.')
  })

  it('rejects when setting MFA preference fails', async () => {
    behaviour.auth = 'mfaSetup'
    behaviour.prefFail = true
    const { user } = await signIn('a@x.com', 'pw')
    await expect(verifyTotp(user, '123456')).rejects.toThrow('Something went wrong. Please try again.')
  })

  it('rejects when associate fails', async () => {
    behaviour.auth = 'mfaSetup'
    behaviour.associateFail = true
    const { user } = await signIn('a@x.com', 'pw')
    await expect(associateTotp(user)).rejects.toThrow('Something went wrong. Please try again.')
  })
})

// ---------------------------------------------------------------------------
// Token refresh / logout
// ---------------------------------------------------------------------------
describe('getAccessToken', () => {
  it('returns null when no user is signed in', async () => {
    currentUser = null
    expect(await getAccessToken()).toBeNull()
  })

  it('returns a refreshed token for a valid session', async () => {
    currentUser = new FakeCognitoUser({ Username: 'a@x.com' })
    expect(await getAccessToken()).toBe('refreshed-access')
  })

  it('returns null for an invalid/expired session', async () => {
    currentUser = new FakeCognitoUser({ Username: 'a@x.com' })
    currentUser._behaviour = { sessionInvalid: true }
    expect(await getAccessToken()).toBeNull()
  })
})

describe('signOut', () => {
  it('signs out the current user', () => {
    const u = new FakeCognitoUser({ Username: 'a@x.com' })
    u._behaviour = {}
    currentUser = u
    signOut()
    expect(u._behaviour.signedOut).toBe(true)
  })

  it('is a no-op when nobody is signed in', () => {
    currentUser = null
    expect(() => signOut()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// completeNewPassword (invited / migrated users)
// ---------------------------------------------------------------------------
describe('completeNewPassword', () => {
  it('returns SUCCESS when the new password is accepted', async () => {
    behaviour.auth = 'newPassword'
    const { user } = await signIn('a@x.com', 'pw')
    const result = await completeNewPassword(user, 'A-brand-new-pass-123!')
    expect(result.status).toBe(AuthStatus.SUCCESS)
    expect(result.tokens.accessToken).toBe('newpw-access')
  })

  it('can chain into an MFA challenge', async () => {
    behaviour.auth = 'newPassword'
    behaviour.newPwThenMfa = true
    const { user } = await signIn('a@x.com', 'pw')
    const result = await completeNewPassword(user, 'A-brand-new-pass-123!')
    expect(result.status).toBe(AuthStatus.MFA_REQUIRED)
  })

  it('rejects an invalid new password', async () => {
    behaviour.auth = 'newPassword'
    behaviour.newPwFail = true
    const { user } = await signIn('a@x.com', 'pw')
    await expect(completeNewPassword(user, 'weak')).rejects.toThrow('Something went wrong. Please try again.')
  })
})

// ---------------------------------------------------------------------------
// Phone number (profile)
// ---------------------------------------------------------------------------
describe('phone number management', () => {
  beforeEach(() => {
    const u = new FakeCognitoUser({ Username: 'a@x.com' })
    u._behaviour = { validCode: '123456' }
    currentUser = u
  })

  it('updates the phone number (pending verification)', async () => {
    const r = await updatePhoneNumber('+911234567890')
    expect(r.status).toBe('PENDING_VERIFICATION')
  })

  it('sends a verification code', async () => {
    const r = await sendPhoneVerificationCode()
    expect(r.status).toBe('CODE_SENT')
  })

  it('reports when Cognito cannot deliver SMS in the current configuration', async () => {
    currentUser._behaviour.sendCodeFail = true
    currentUser._behaviour.sendCodeError = 'CodeDeliveryFailureException'
    await expect(sendPhoneVerificationCode()).rejects.toThrow(
      'Cognito could not send the SMS. Check phone number and SMS delivery availability.',
    )
  })

  it('confirms the phone with a correct code', async () => {
    const r = await confirmPhoneNumber('123456')
    expect(r.status).toBe('VERIFIED')
  })

  it('rejects a wrong confirmation code', async () => {
    await expect(confirmPhoneNumber('000000')).rejects.toThrow('That code is incorrect. Try again.')
  })

  it('rejects when signed out', async () => {
    currentUser = null
    await expect(updatePhoneNumber('+911234567890')).rejects.toThrow('You are not signed in.')
  })
})

describe('password change for signed-in user', () => {
  beforeEach(() => {
    const user = new FakeCognitoUser({ Username: 'a@x.com' })
    user._behaviour = { validCode: '123456' }
    currentUser = user
  })

  it('changes the password through the current authenticated Cognito user', async () => {
    await expect(changePassword('Current!123456', 'NewPass!123456')).resolves.toEqual({ status: 'CHANGED' })
    expect(currentUser._behaviour.passwordChange).toEqual({
      currentPassword: 'Current!123456',
      newPassword: 'NewPass!123456',
    })
  })

  it('returns a safe message for an incorrect current password', async () => {
    currentUser._behaviour.passwordChangeError = { code: 'NotAuthorizedException' }
    await expect(changePassword('wrong', 'NewPass!123456')).rejects.toThrow('The current password is incorrect.')
  })

  it('rejects when the session is expired', async () => {
    currentUser._behaviour.sessionInvalid = true
    await expect(changePassword('Current!123456', 'NewPass!123456')).rejects.toThrow(
      'Your session has expired. Please sign in again.',
    )
    expect(currentUser._behaviour.passwordChange).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Standalone TOTP setup / reset (profile)
// ---------------------------------------------------------------------------
describe('TOTP setup/reset for signed-in user', () => {
  beforeEach(() => {
    const u = new FakeCognitoUser({ Username: 'a@x.com' })
    u._behaviour = { validCode: '123456' }
    currentUser = u
  })

  it('setupTotp returns a secret and otpauth URI', async () => {
    const { secretCode, otpauthUri } = await setupTotp({ accountLabel: 'a@x.com' })
    expect(secretCode).toBe('SECRET123')
    expect(otpauthUri).toContain('otpauth://totp/')
  })

  it('confirmTotpSetup succeeds for a correct code', async () => {
    const r = await confirmTotpSetup('123456')
    expect(r.status).toBe(AuthStatus.SUCCESS)
  })

  it('disableTotp turns MFA off', async () => {
    const r = await disableTotp()
    expect(r.status).toBe('DISABLED')
  })
})
