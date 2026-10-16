// Cognito authentication wrapper (Phase c1).
//
// A thin, promise-based layer over `amazon-cognito-identity-js` that exposes
// the exact challenge sequence our App Client is configured for (SRP sign-in +
// TOTP software-token MFA). It:
//   - never stores or logs passwords / MFA codes / TOTP secrets / tokens,
//   - returns the Cognito ACCESS token for API calls (role is resolved from
//     PostgreSQL by the backend, never from the token),
//   - keeps the SDK classes INJECTABLE so unit tests run without real AWS.
//
// Result shape from signIn()/respondToMfaChallenge():
//   { status: 'SUCCESS', tokens }                      -> authenticated
//   { status: 'MFA_REQUIRED', user, challengeName }    -> enter TOTP code
//   { status: 'MFA_SETUP_REQUIRED', user }             -> enroll TOTP first
//   { status: 'NEW_PASSWORD_REQUIRED', user }          -> set a new password
// Errors reject with an Error carrying a safe, user-facing message.

import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserAttribute,
} from 'amazon-cognito-identity-js'

import { getCognitoConfig } from './config'

export const AuthStatus = {
  SUCCESS: 'SUCCESS',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_SETUP_REQUIRED: 'MFA_SETUP_REQUIRED',
  NEW_PASSWORD_REQUIRED: 'NEW_PASSWORD_REQUIRED',
}

// SDK classes are injectable so tests can pass fakes. Production uses the real
// amazon-cognito-identity-js classes imported above.
let sdk = { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoUserAttribute }

export function __setSdk(fakeSdk) {
  sdk = { ...sdk, ...fakeSdk }
}

export function __resetSdk() {
  sdk = { CognitoUserPool, CognitoUser, AuthenticationDetails, CognitoUserAttribute }
}

/** Register a public Cognito user; the Cognito pool sends the email code. */
export function signUp(email, password, name) {
  const pool = buildUserPool()
  const attributes = [
    new sdk.CognitoUserAttribute({ Name: 'email', Value: email.trim().toLowerCase() }),
    new sdk.CognitoUserAttribute({ Name: 'name', Value: name.trim() }),
  ]
  return new Promise((resolve, reject) => {
    pool.signUp(email.trim().toLowerCase(), password, attributes, null, (err, result) => {
      if (err) {
        reject(new Error(safeMessage(err)))
        return
      }
      resolve({ userConfirmed: Boolean(result?.userConfirmed) })
    })
  })
}

/** Confirm the email address associated with a public Cognito SignUp. */
export function confirmSignUp(email, code) {
  const user = makeUser(email.trim().toLowerCase())
  return new Promise((resolve, reject) => {
    user.confirmRegistration(code, false, (err) => {
      if (err) {
        reject(new Error(safeMessage(err)))
        return
      }
      resolve()
    })
  })
}

/** Resend Cognito's email confirmation code. */
export function resendSignUpCode(email) {
  const user = makeUser(email.trim().toLowerCase())
  return new Promise((resolve, reject) => {
    user.resendConfirmationCode((err) => {
      if (err) {
        reject(new Error(safeMessage(err)))
        return
      }
      resolve()
    })
  })
}

function buildUserPool() {
  const { userPoolId, clientId } = getCognitoConfig()
  if (!userPoolId || !clientId) {
    throw new Error('Cognito is not configured.')
  }
  return new sdk.CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId })
}

function makeUser(email, pool) {
  return new sdk.CognitoUser({ Username: email, Pool: pool || buildUserPool() })
}

function tokensFrom(session) {
  // Access token drives API auth; id token is available if ever needed; the
  // refresh token stays inside the SDK session and is not surfaced here.
  return {
    accessToken: session.getAccessToken().getJwtToken(),
    idToken: session.getIdToken().getJwtToken(),
  }
}

// Normalise Cognito SDK errors into safe, user-facing messages without leaking
// internals. Avoids user-enumeration where possible.
function safeMessage(err) {
  const code = err && (err.code || err.name)
  switch (code) {
    case 'NotAuthorizedException':
      return 'Email or password is incorrect.'
    case 'UserNotFoundException':
      return 'Email or password is incorrect.'
    case 'CodeMismatchException':
      return 'That code is incorrect. Try again.'
    case 'ExpiredCodeException':
      return 'That code has expired. Request a new one.'
    case 'PasswordResetRequiredException':
      return 'A password reset is required. Use "Forgot password".'
    case 'UserNotConfirmedException':
      return 'Your account is not yet confirmed.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

/**
 * Begin SRP sign-in. Resolves to a discriminated result (see file header).
 * The CognitoUser is returned on challenge states so the caller can continue
 * the exact same session (required by the SDK's callback model).
 */
export function signIn(email, password) {
  const pool = buildUserPool()
  const user = makeUser(email, pool)
  const authDetails = new sdk.AuthenticationDetails({ Username: email, Password: password })

  return new Promise((resolve, reject) => {
    user.authenticateUser(authDetails, {
      onSuccess: (session) => resolve({ status: AuthStatus.SUCCESS, tokens: tokensFrom(session), user }),
      onFailure: (err) => reject(new Error(safeMessage(err))),
      totpRequired: (challengeName = 'SOFTWARE_TOKEN_MFA') =>
        resolve({ status: AuthStatus.MFA_REQUIRED, user, challengeName }),
      mfaRequired: (challengeName = 'SMS_MFA') =>
        resolve({ status: AuthStatus.MFA_REQUIRED, user, challengeName }),
      mfaSetup: () => resolve({ status: AuthStatus.MFA_SETUP_REQUIRED, user }),
      newPasswordRequired: () => resolve({ status: AuthStatus.NEW_PASSWORD_REQUIRED, user }),
    })
  })
}

/** Answer a TOTP (software token) MFA challenge for a signing-in user. */
export function respondToMfaChallenge(user, code, challengeName = 'SOFTWARE_TOKEN_MFA') {
  return new Promise((resolve, reject) => {
    user.sendMFACode(
      code,
      {
        onSuccess: (session) => resolve({ status: AuthStatus.SUCCESS, tokens: tokensFrom(session), user }),
        onFailure: (err) => reject(new Error(safeMessage(err))),
      },
      challengeName,
    )
  })
}

/**
 * Begin TOTP enrollment: associate a software token and return the secret plus
 * an otpauth:// URI (for a QR code). The secret is shown once to the user and
 * never persisted by us.
 */
export function associateTotp(user, { issuer = 'Cloudnaut Support Desk', accountLabel } = {}) {
  return new Promise((resolve, reject) => {
    user.associateSoftwareToken({
      associateSecretCode: (secretCode) => {
        const label = encodeURIComponent(accountLabel || 'account')
        const iss = encodeURIComponent(issuer)
        const otpauthUri = `otpauth://totp/${iss}:${label}?secret=${secretCode}&issuer=${iss}`
        resolve({ secretCode, otpauthUri })
      },
      onFailure: (err) => reject(new Error(safeMessage(err))),
    })
  })
}

/** Verify the 6-digit code to complete TOTP enrollment, then prefer TOTP MFA. */
export function verifyTotp(user, code, friendlyDeviceName = 'authenticator') {
  return new Promise((resolve, reject) => {
    user.verifySoftwareToken(code, friendlyDeviceName, {
      onSuccess: (verifiedSession) => {
        user.setUserMfaPreference(
          null,
          { PreferredMfa: true, Enabled: true },
          (err) => {
            if (err) {
              reject(new Error(safeMessage(err)))
              return
            }
            // After verifying the software token during sign-in, the user has
            // an authenticated session. Surface its tokens so the caller does
            // not have to re-fetch from the (not-yet-persisted) store.
            let tokens = null
            try {
              const session = verifiedSession?.getAccessToken
                ? verifiedSession
                : user.getSignInUserSession()
              if (session && session.isValid()) tokens = tokensFrom(session)
            } catch {
              tokens = null
            }
            resolve({ status: AuthStatus.SUCCESS, tokens, user })
          },
        )
      },
      onFailure: (err) => reject(new Error(safeMessage(err))),
    })
  })
}

/**
 * Return the current access token, refreshing via the stored session if needed.
 * Resolves null when there is no signed-in user (caller treats as logged out).
 */
export function getAccessToken() {
  return new Promise((resolve) => {
    let user
    try {
      user = buildUserPool().getCurrentUser()
    } catch {
      resolve(null)
      return
    }
    if (!user) {
      resolve(null)
      return
    }
    user.getSession((err, session) => {
      if (err || !session || !session.isValid()) {
        resolve(null)
        return
      }
      resolve(session.getAccessToken().getJwtToken())
    })
  })
}

/** Sign the current user out locally (clears the SDK's stored session). */
export function signOut() {
  let user
  try {
    user = buildUserPool().getCurrentUser()
  } catch {
    return
  }
  if (user) user.signOut()
}

/**
 * Complete a NEW_PASSWORD_REQUIRED challenge (invited/migrated users set their
 * own password on first sign-in). Resolves to the same discriminated result as
 * signIn(): SUCCESS, or an MFA/MFA-setup state if the pool requires it next.
 */
export function completeNewPassword(user, newPassword) {
  return new Promise((resolve, reject) => {
    user.completeNewPasswordChallenge(
      newPassword,
      {}, // no required attributes to supply
      {
        onSuccess: (session) => resolve({ status: AuthStatus.SUCCESS, tokens: tokensFrom(session), user }),
        onFailure: (err) => reject(new Error(safeMessage(err))),
        totpRequired: (challengeName = 'SOFTWARE_TOKEN_MFA') =>
          resolve({ status: AuthStatus.MFA_REQUIRED, user, challengeName }),
        mfaRequired: (challengeName = 'SMS_MFA') =>
          resolve({ status: AuthStatus.MFA_REQUIRED, user, challengeName }),
        mfaSetup: () => resolve({ status: AuthStatus.MFA_SETUP_REQUIRED, user }),
      },
    )
  })
}

/** Change the signed-in user's Cognito password after verifying the current password. */
export function changePassword(currentPassword, newPassword) {
  return currentUserWithSession().then(
    (user) =>
      new Promise((resolve, reject) => {
        user.changePassword(currentPassword, newPassword, (err) => {
          if (!err) {
            resolve({ status: 'CHANGED' })
            return
          }
          if (err.code === 'NotAuthorizedException' || err.name === 'NotAuthorizedException') {
            reject(new Error('The current password is incorrect.'))
            return
          }
          if (
            ['InvalidPasswordException', 'PasswordHistoryPolicyViolationException'].includes(
              err.code || err.name,
            )
          ) {
            reject(new Error('The new password does not meet your account password requirements.'))
            return
          }
          reject(new Error(safeMessage(err)))
        })
      }),
  )
}

// Resolve the current signed-in CognitoUser WITH a valid session attached, so
// attribute/MFA operations below can authenticate. Rejects when logged out.
function currentUserWithSession() {
  return new Promise((resolve, reject) => {
    let user
    try {
      user = buildUserPool().getCurrentUser()
    } catch (err) {
      reject(new Error(safeMessage(err)))
      return
    }
    if (!user) {
      reject(new Error('You are not signed in.'))
      return
    }
    user.getSession((err, session) => {
      if (err || !session || !session.isValid()) {
        reject(new Error('Your session has expired. Please sign in again.'))
        return
      }
      resolve(user)
    })
  })
}

/** Set/replace the signed-in user's phone_number attribute (triggers verification). */
export function updatePhoneNumber(phoneNumber) {
  return currentUserWithSession().then(
    (user) =>
      new Promise((resolve, reject) => {
        const attribute = { Name: 'phone_number', Value: phoneNumber }
        user.updateAttributes([attribute], (err) =>
          err ? reject(new Error(safeMessage(err))) : resolve({ status: 'PENDING_VERIFICATION' }),
        )
      }),
  )
}

/** Ask Cognito to send a phone_number verification code (SMS) to the user. */
export function sendPhoneVerificationCode() {
  return currentUserWithSession().then(
    (user) =>
      new Promise((resolve, reject) => {
        user.getAttributeVerificationCode('phone_number', {
          onSuccess: () => resolve({ status: 'CODE_SENT' }),
          onFailure: (err) => {
            const code = err && (err.code || err.name)
            if (code === 'CodeDeliveryFailureException') {
              reject(new Error('Cognito could not send the SMS. Check phone number and SMS delivery availability.'))
            } else if (code === 'LimitExceededException') {
              reject(new Error('Too many verification codes were requested. Wait before trying again.'))
            } else if (code === 'InvalidParameterException') {
              reject(new Error('Enter a valid phone number in international format, such as +911234567890.'))
            } else {
              reject(new Error(safeMessage(err)))
            }
          },
        })
      }),
  )
}

/** Confirm the phone_number with the SMS code the user received. */
export function confirmPhoneNumber(code) {
  return currentUserWithSession().then(
    (user) =>
      new Promise((resolve, reject) => {
        user.verifyAttribute('phone_number', code, {
          onSuccess: () => resolve({ status: 'VERIFIED' }),
          onFailure: (err) => reject(new Error(safeMessage(err))),
        })
      }),
  )
}

/** Begin TOTP (re)enrollment for the signed-in user: returns secret + otpauth URI. */
export function setupTotp({ issuer = 'Cloudnaut Support Desk', accountLabel } = {}) {
  return currentUserWithSession().then((user) => associateTotp(user, { issuer, accountLabel }))
}

/** Verify a TOTP code to finish (re)enrollment for the signed-in user. */
export function confirmTotpSetup(code) {
  return currentUserWithSession().then((user) => verifyTotp(user, code))
}

/** Disable TOTP MFA for the signed-in user (reset flow before re-enrolling). */
export function disableTotp() {
  return currentUserWithSession().then(
    (user) =>
      new Promise((resolve, reject) => {
        user.setUserMfaPreference(
          null,
          { PreferredMfa: false, Enabled: false },
          (err) => (err ? reject(new Error(safeMessage(err))) : resolve({ status: 'DISABLED' })),
        )
      }),
  )
}
