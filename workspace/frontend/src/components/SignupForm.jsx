import { useState } from 'react'
import { apiFetch } from '../api'
import {
	AuthStatus,
	associateTotp,
	completeNewPassword,
	confirmSignUp,
	getAccessToken,
	resendSignUpCode,
	respondToMfaChallenge,
	signIn,
	signUp,
	verifyTotp,
} from '../cognito/cognitoAuth'

function SignupForm({ initialRole, onBackToLogin, onForgotPassword }) {
	const [name, setName] = useState('')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [role, setRole] = useState(initialRole === 'support' ? 'support' : 'employee')
	const [message, setMessage] = useState('')
	const [stage, setStage] = useState('register')
	const [challenge, setChallenge] = useState(null)
	const [code, setCode] = useState('')
	const [newPassword, setNewPassword] = useState('')
	const [error, setError] = useState('')
	const [submitting, setSubmitting] = useState(false)

	const submitAccessRequest = async (token) => {
		setStage('request')
		const response = await apiFetch('/auth/signup', {
			method: 'POST',
			authToken: token,
			body: JSON.stringify({ role, message }),
		})
		const data = await response.json()
		if (!response.ok) throw new Error(data.detail || 'Could not submit your access request.')
		setStage('submitted')
	}

	const advanceAuthentication = async (result) => {
		if (result.status === AuthStatus.SUCCESS) {
			const token = result.tokens?.accessToken || await getAccessToken()
			if (!token) throw new Error('Sign-in completed without an access token. Please sign in again.')
			setPassword('')
			await submitAccessRequest(token)
			return
		}
		if (result.status === AuthStatus.NEW_PASSWORD_REQUIRED) {
			setPassword('')
			setChallenge({ ...result, type: 'new-password' })
			setStage('challenge')
			return
		}
		if (result.status === AuthStatus.MFA_REQUIRED) {
			setPassword('')
			setChallenge({ ...result, type: 'mfa' })
			setStage('challenge')
			return
		}
		if (result.status === AuthStatus.MFA_SETUP_REQUIRED) {
			setPassword('')
			const enrollment = await associateTotp(result.user, {
				issuer: 'Cloudnaut Support Desk',
				accountLabel: email,
			})
			setChallenge({ ...result, ...enrollment, type: 'totp-setup' })
			setStage('challenge')
		}
	}

	const handleRegister = async (event) => {
		event.preventDefault()
		setSubmitting(true)
		setError('')
		try {
			await signUp(email, password, name)
			setStage('confirm')
		} catch (submitError) {
			setError(submitError.message || 'Could not create the Cognito account.')
		} finally {
			setSubmitting(false)
		}
	}

	const handleConfirmation = async (event) => {
		event.preventDefault()
		setSubmitting(true)
		setError('')
		try {
			await confirmSignUp(email, code.trim())
			setStage('authenticate')
		} catch (submitError) {
			setError(submitError.message || 'Could not verify your email.')
		} finally {
			setSubmitting(false)
		}
	}

	const handleSignIn = async (event) => {
		event.preventDefault()
		setSubmitting(true)
		setError('')
		try {
			const result = await signIn(email, password)
			setPassword('')
			await advanceAuthentication(result)
		} catch (submitError) {
			setError(submitError.message || 'Could not sign in to the verified account.')
		} finally {
			setSubmitting(false)
		}
	}

	const handleChallenge = async (event) => {
		event.preventDefault()
		setSubmitting(true)
		setError('')
		try {
			let result
			if (challenge.type === 'new-password') {
				result = await completeNewPassword(challenge.user, newPassword)
				setNewPassword('')
			} else if (challenge.type === 'totp-setup') {
				result = await verifyTotp(challenge.user, code.trim())
			} else {
				result = await respondToMfaChallenge(
					challenge.user,
					code.trim(),
					challenge.challengeName,
				)
			}
			if (challenge.type === 'totp-setup') setCode('')
			await advanceAuthentication(result)
		} catch (submitError) {
			setError(submitError.message || 'Could not complete the sign-in challenge.')
		} finally {
			setSubmitting(false)
		}
	}

	const handleResendCode = async () => {
		setSubmitting(true)
		setError('')
		try {
			await resendSignUpCode(email)
		} catch (submitError) {
			setError(submitError.message || 'Could not resend the verification code.')
		} finally {
			setSubmitting(false)
		}
	}

	const handleSubmitRequest = async (event) => {
		event.preventDefault()
		setSubmitting(true)
		setError('')
		try {
			const token = await getAccessToken()
			if (!token) throw new Error('Your sign-in session expired. Please sign in again.')
			await submitAccessRequest(token)
		} catch (submitError) {
			setError(submitError.message || 'Could not submit your access request.')
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<section className="ticket-form-card auth-card">
			<span className="section-label">ACCOUNT REQUEST</span>
			<h2>{stage === 'submitted' ? 'Request submitted' : stage === 'confirm' ? 'Verify your email' : stage === 'authenticate' ? 'Sign in to continue' : stage === 'challenge' ? 'Complete sign-in' : stage === 'request' ? 'Submit access request' : 'Sign up'}</h2>
			{stage === 'submitted' ? (
				<>
					<p>Your email is verified and your request is pending Admin approval. You can sign in after approval.</p>
					<button type="button" className="secondary-button" onClick={onBackToLogin}>Back to sign in</button>
				</>
			) : stage === 'request' ? (
				<form className="ticket-form" onSubmit={handleSubmitRequest}>
					<p>Your email is verified. Submit the {role === 'employee' ? 'Employee' : 'Support'} access request for Admin review.</p>
					{error && <div className="error-box"><strong>Unable to submit request</strong><span>{error}</span></div>}
					<button type="submit" className="submit-button" disabled={submitting}>{submitting ? 'Submitting request...' : 'Submit access request'}</button>
				</form>
			) : stage === 'confirm' ? (
				<form className="ticket-form" onSubmit={handleConfirmation}>
					<p>Enter the verification code sent to {email}.</p>
					<div className="form-group">
						<label htmlFor="signup-code">Email verification code</label>
						<input id="signup-code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value)} />
					</div>
					{error && <div className="error-box"><strong>Unable to verify email</strong><span>{error}</span></div>}
					<button type="submit" className="submit-button" disabled={submitting}>{submitting ? 'Verifying...' : 'Verify email'}</button>
					<button type="button" className="secondary-button" disabled={submitting} onClick={handleResendCode}>Resend code</button>
				</form>
			) : stage === 'authenticate' ? (
				<form className="ticket-form" onSubmit={handleSignIn}>
					<p>Your email is verified. Sign in to securely link this request to your Cognito identity.</p>
					<div className="form-group">
						<label htmlFor="signup-confirmed-password">Password</label>
						<input id="signup-confirmed-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
					</div>
					{error && <div className="error-box"><strong>Unable to sign in</strong><span>{error}</span></div>}
					<button type="submit" className="submit-button" disabled={submitting}>{submitting ? 'Signing in...' : 'Sign in and continue'}</button>
				</form>
			) : stage === 'challenge' ? (
				<form className="ticket-form" onSubmit={handleChallenge}>
					{challenge.type === 'totp-setup' ? (
						<>
							<p>Set up an authenticator app with this one-time setup key:</p>
							<code>{challenge.secretCode}</code>
						</>
					) : (
						<p>{challenge.type === 'new-password' ? 'Choose a new password to continue.' : 'Enter the current code from your authenticator app.'}</p>
					)}
					<div className="form-group">
						<label htmlFor="signup-challenge-code">{challenge.type === 'new-password' ? 'New password' : 'Authenticator code'}</label>
						<input
							id="signup-challenge-code"
							type={challenge.type === 'new-password' ? 'password' : 'text'}
							autoComplete={challenge.type === 'new-password' ? 'new-password' : 'one-time-code'}
							inputMode={challenge.type === 'new-password' ? undefined : 'numeric'}
							required
							value={challenge.type === 'new-password' ? newPassword : code}
							onChange={(event) => challenge.type === 'new-password' ? setNewPassword(event.target.value) : setCode(event.target.value)}
						/>
					</div>
					{error && <div className="error-box"><strong>Unable to complete sign-in</strong><span>{error}</span></div>}
					<button type="submit" className="submit-button" disabled={submitting}>{submitting ? 'Continuing...' : 'Continue'}</button>
				</form>
			) : (
				<>
					<p>Register with a verified email address. An Admin must approve your Employee or Support account before you can use the application.</p>
					<form className="ticket-form" onSubmit={handleRegister}>
						<div className="form-group">
							<label htmlFor="signup-name">Full name</label>
							<input id="signup-name" autoComplete="name" required maxLength="100" value={name} onChange={(event) => setName(event.target.value)} />
						</div>
						<div className="form-group">
							<label htmlFor="signup-email">Work email</label>
							<input id="signup-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
						</div>
						<div className="form-group">
							<label htmlFor="signup-password">Password</label>
							<input id="signup-password" type="password" autoComplete="new-password" required minLength="12" maxLength="200" value={password} onChange={(event) => setPassword(event.target.value)} />
						</div>
						<div className="form-group">
							<label htmlFor="signup-role">Account type</label>
							<select id="signup-role" value={role} onChange={(event) => setRole(event.target.value)}>
								<option value="employee">Staff</option>
								<option value="support">Support Team</option>
							</select>
						</div>
						<div className="form-group">
							<label htmlFor="signup-message">Reason for access <span className="optional-label">(optional)</span></label>
							<textarea id="signup-message" maxLength="1000" value={message} onChange={(event) => setMessage(event.target.value)} />
						</div>
						{error && <div className="error-box"><strong>Unable to sign up</strong><span>{error}</span></div>}
						<button type="submit" className="submit-button" disabled={submitting}>{submitting ? 'Registering...' : 'Register'}</button>
						<button type="button" className="secondary-button" onClick={onBackToLogin}>Back to sign in</button>
						<p className="auth-signup-prompt"><button type="button" className="auth-link" onClick={onForgotPassword}>Forgot password?</button></p>
					</form>
				</>
			)}
		</section>
	)
}

export default SignupForm
