"""Amazon Cognito access-token verification (Phase 3a).

This module validates Cognito-issued **access** tokens cryptographically and is
deliberately decoupled from FastAPI and SQLAlchemy so it can be unit-tested in
isolation with a mocked JWKS source. It introduces NO new third-party
dependency: PyJWT (already required for the legacy HS256 flow) ships
``PyJWKClient`` and, with the ``cryptography`` extra, RS256 support.

Security contract (fail-closed): every token is rejected unless ALL of the
following hold, verified against Cognito's regional JWKS:

  * RS256 signature valid for a key published at the pool's JWKS endpoint
  * ``iss`` equals the configured User Pool issuer
  * ``exp`` not in the past (and ``nbf``/``iat`` if present)
  * ``token_use == "access"`` (we standardise on the access token for the API)
  * ``client_id`` equals the configured App Client ID

Access tokens do NOT carry an ``aud`` claim (ID tokens do); Cognito binds an
access token to its client via the ``client_id`` claim, which we check
explicitly. Application role and account status are NEVER taken from the token
— the caller maps the verified ``sub`` to PostgreSQL and reads role/is_active
from there.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass

import jwt
from jwt import PyJWKClient


# ---------------------------------------------------------------------------
# AUTH_MODE — controls which authentication schemes the service accepts.
#   "legacy"  : only the existing HS256 app token (DEFAULT; no behaviour change)
#   "dual"    : accept a valid Cognito access token OR a legacy HS256 token
#   "cognito" : only Cognito access tokens; legacy tokens are rejected
# A malformed/invalid Cognito token is NEVER downgraded to legacy: in dual mode
# a token that looks like a Cognito token but fails validation is rejected.
# ---------------------------------------------------------------------------
AUTH_MODE_LEGACY = "legacy"
AUTH_MODE_DUAL = "dual"
AUTH_MODE_COGNITO = "cognito"
_VALID_AUTH_MODES = {AUTH_MODE_LEGACY, AUTH_MODE_DUAL, AUTH_MODE_COGNITO}


def get_auth_mode() -> str:
    """Return the configured AUTH_MODE, defaulting to 'legacy'.

    Read at call time (not import time) so tests and deployments can set it via
    the environment. An unrecognised value fails closed to 'legacy' rather than
    silently enabling Cognito.
    """
    mode = os.getenv("AUTH_MODE", AUTH_MODE_LEGACY).strip().lower()
    return mode if mode in _VALID_AUTH_MODES else AUTH_MODE_LEGACY


def cognito_enabled() -> bool:
    return get_auth_mode() in {AUTH_MODE_DUAL, AUTH_MODE_COGNITO}


class CognitoConfigurationError(RuntimeError):
    """Cognito verification was requested but is not fully configured."""


class CognitoTokenError(Exception):
    """A token failed Cognito validation. Message is safe to surface (no secrets)."""


class CognitoVerificationUnavailable(RuntimeError):
    """Cognito signing keys could not be retrieved to validate a token."""


@dataclass(frozen=True)
class CognitoClaims:
    """The small, trusted subset of claims we rely on after verification."""

    sub: str
    username: str | None
    client_id: str
    token_use: str


class CognitoVerifier:
    """Verifies Cognito access tokens against a pool's JWKS.

    The JWKS keys are fetched lazily on first use and cached by ``PyJWKClient``
    (which also re-fetches when it sees an unknown ``kid``, handling rotation).
    A single verifier instance is safe to share across threads.
    """

    def __init__(
        self,
        *,
        region: str,
        user_pool_id: str,
        app_client_id: str,
        jwk_client: PyJWKClient | None = None,
    ):
        if not region or not user_pool_id or not app_client_id:
            raise CognitoConfigurationError(
                "Cognito verification requires AWS_REGION, COGNITO_USER_POOL_ID "
                "and COGNITO_APP_CLIENT_ID to be set."
            )
        self.region = region
        self.user_pool_id = user_pool_id
        self.app_client_id = app_client_id
        self.issuer = f"https://cognito-idp.{region}.amazonaws.com/{user_pool_id}"
        self.jwks_uri = f"{self.issuer}/.well-known/jwks.json"
        # Injectable for tests; otherwise a cached JWKS client with rotation.
        self._jwk_client = jwk_client or PyJWKClient(
            self.jwks_uri,
            cache_keys=True,
            lifespan=3600,
        )

    def verify_access_token(self, token: str) -> CognitoClaims:
        """Validate a Cognito access token or raise CognitoTokenError.

        Raises (never returns) on any failure so callers fail closed.
        """
        if not token or not isinstance(token, str):
            raise CognitoTokenError("Missing token.")
        try:
            signing_key = self._jwk_client.get_signing_key_from_jwt(token)
        except jwt.PyJWKClientConnectionError as error:
            raise CognitoVerificationUnavailable(
                "Cognito signing keys are temporarily unavailable."
            ) from error
        except (jwt.PyJWKClientError, jwt.DecodeError, TypeError, ValueError) as error:
            raise CognitoTokenError("Token signing key could not be resolved.") from error

        try:
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                issuer=self.issuer,
                # Access tokens have no 'aud'; disable aud verification and
                # enforce client binding via the 'client_id' claim below.
                options={
                    "verify_aud": False,
                    "require": ["exp", "iss", "sub", "token_use", "client_id"],
                },
            )
        except jwt.InvalidTokenError as error:
            # Covers bad signature, expired, wrong issuer, missing required claim.
            raise CognitoTokenError("Token is invalid or expired.") from error

        token_use = claims.get("token_use")
        if token_use != "access":
            raise CognitoTokenError(
                f"Unexpected token_use '{token_use}'; an access token is required."
            )

        client_id = claims.get("client_id")
        if client_id != self.app_client_id:
            raise CognitoTokenError("Token was not issued for this application client.")

        sub = claims.get("sub")
        if not sub:
            raise CognitoTokenError("Token is missing the subject (sub) claim.")

        return CognitoClaims(
            sub=sub,
            username=claims.get("username"),
            client_id=client_id,
            token_use=token_use,
        )


# ---------------------------------------------------------------------------
# Process-wide singleton, built lazily from the environment. Tests can inject a
# verifier with a fake JWKS client via ``set_verifier`` and reset via
# ``reset_verifier``.
# ---------------------------------------------------------------------------
_verifier: CognitoVerifier | None = None
_verifier_lock = threading.Lock()


def set_verifier(verifier: CognitoVerifier | None) -> None:
    global _verifier
    with _verifier_lock:
        _verifier = verifier


def reset_verifier() -> None:
    set_verifier(None)


def get_verifier() -> CognitoVerifier:
    """Return the shared verifier, constructing it from env on first use."""
    global _verifier
    if _verifier is not None:
        return _verifier
    with _verifier_lock:
        if _verifier is None:
            _verifier = CognitoVerifier(
                region=os.getenv("AWS_REGION", "").strip(),
                user_pool_id=os.getenv("COGNITO_USER_POOL_ID", "").strip(),
                app_client_id=os.getenv("COGNITO_APP_CLIENT_ID", "").strip(),
            )
        return _verifier


def looks_like_cognito_token(token: str) -> bool:
    """Best-effort, SIGNATURE-FREE hint used only to pick a validation path.

    Returns True when the token's unverified payload carries an ``iss`` that
    points at a Cognito User Pool. This is NEVER used to trust a token — only to
    decide, in dual mode, whether to run Cognito validation (and then fail
    closed on error) versus the legacy HS256 path. A token claiming a Cognito
    issuer is always routed to Cognito validation so it cannot be downgraded.
    """
    try:
        unverified = jwt.decode(token, options={"verify_signature": False})
    except jwt.InvalidTokenError:
        return False
    issuer = unverified.get("iss", "")
    return isinstance(issuer, str) and "cognito-idp." in issuer and "/" in issuer
