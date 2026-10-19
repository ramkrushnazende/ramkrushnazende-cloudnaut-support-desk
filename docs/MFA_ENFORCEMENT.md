# Admin-Controlled MFA Enforcement

## Behavior

The Cognito User Pool remains `OPTIONAL` for MFA. This preserves the existing login, TOTP, SMS, and administrator behavior. The application policy is stored in the singleton `security_settings` row as `require_staff_mfa` and is changed only by an authenticated administrator.

When the policy is disabled, employees and support staff retain the existing optional-MFA behavior. When enabled:

- Active employees and support staff must have a linked Cognito identity and a verified `SOFTWARE_TOKEN_MFA` factor before accessing tickets, dashboards, team data, notes, progress updates, or attachments.
- Administrators bypass the staff enrollment requirement and retain access to administration screens.
- The backend checks the policy and calls Cognito `GetUser` using the validated bearer token. The database `mfa_enabled` field and browser state are display-only and are never authorization inputs.
- Cognito `/auth/whoami` resolution returns `mfa_required` and the enforcement state so the SPA can show the enrollment gate.
- Profile MFA status and enrollment endpoints remain available to an authenticated unenrolled user so setup can complete.
- The frontend gate displays a QR code/manual TOTP secret, verifies the six-digit code, refreshes the backend identity, and only then renders protected pages.

## Admin workflow

1. Sign in as an administrator.
2. Open **Manage Staff Access**.
3. Under **Staff MFA enforcement**, enable or disable the policy.
4. Enabling is rejected if active employee/support accounts are not linked to Cognito, or if the backend is running in legacy-only mode.
5. Each staff member sees the MFA enrollment gate on their next identity resolution/session restore and must complete TOTP setup.

Disabling the policy restores optional-MFA behavior; it does not remove existing user TOTP factors.

## Deployment and migration

The Alembic migration `f5c8d1e2a304` creates `security_settings` with enforcement disabled. Run the normal database migration pipeline before enabling the policy. The CDK User Pool must remain `MFA: OPTIONAL` with OTP enabled; changing the pool globally to `ON` would also force administrators and can disrupt existing users.

No secrets or TOTP seeds are stored by the application. QR data and manual secrets are held only in component memory during enrollment.

## Security notes

The policy endpoint is admin-only at both the public API and backend layers. Protected backend dependencies fail closed on missing Cognito mappings, invalid tokens, Cognito status errors, subject mismatches, and Cognito service outages. A frontend check alone is not sufficient and is not relied upon.
