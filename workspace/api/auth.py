import logging
import os
import uuid

import httpx
import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from cognito import (
    AUTH_MODE_COGNITO,
    AUTH_MODE_LEGACY,
    CognitoConfigurationError,
    CognitoTokenError,
    CognitoVerificationUnavailable,
    get_auth_mode,
    get_verifier,
    looks_like_cognito_token,
)

logger = logging.getLogger(__name__)

JWT_SECRET = os.getenv("AUTH_SECRET_KEY", "")
JWT_ALGORITHM = "HS256"
bearer_scheme = HTTPBearer(auto_error=False)

# Used (in Cognito/dual mode) to resolve the DB-authoritative identity after a
# Cognito access token is cryptographically validated here. The access token
# does not carry email/role, and only the backend can read them from Postgres.
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8001")
BACKEND_TIMEOUT = float(os.getenv("BACKEND_TIMEOUT", "10"))


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _authenticate_legacy(token: str) -> dict:
    """Validate the existing HS256 app token (claims-based, no DB on this tier)."""
    if not JWT_SECRET:
        raise HTTPException(status_code=500, detail="Authentication is not configured.")
    try:
        claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return {
            "id": int(claims["sub"]),
            "email": claims["email"],
            "name": claims["name"],
            "role": claims["role"],
            "token": token,
        }
    except (jwt.InvalidTokenError, KeyError, TypeError, ValueError) as error:
        raise _unauthorized("Invalid or expired sign-in token.") from error


async def _resolve_identity_from_backend(token: str, request_id: str) -> dict:
    """Ask the internal backend for the DB-authoritative identity.

    The backend validates the token again independently (defence in depth) and
    returns {id,email,name,role} from Postgres via the cognito_sub mapping.
    """
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=BACKEND_TIMEOUT) as client:
            client.headers["X-Request-ID"] = request_id
            response = await client.get(
                "/internal/auth/whoami",
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.TimeoutException as error:
        logger.warning(
            "auth_event=backend_identity_failure request_id=%s category=backend_timeout",
            request_id,
        )
        raise HTTPException(status_code=504, detail="Authentication service timed out.") from error
    except httpx.RequestError as error:
        logger.warning(
            "auth_event=backend_identity_failure request_id=%s category=backend_unavailable",
            request_id,
        )
        raise HTTPException(status_code=502, detail="Authentication service is unavailable.") from error
    if response.status_code == 401:
        logger.warning(
            "auth_event=backend_identity_failure request_id=%s status=401 category=identity_rejected",
            request_id,
        )
        raise _unauthorized("Invalid or expired sign-in token.")
    if response.status_code == 403:
        logger.warning(
            "auth_event=backend_identity_failure request_id=%s status=403 category=identity_forbidden",
            request_id,
        )
        raise HTTPException(status_code=403, detail="Your account is not active or authorized.")
    if not 200 <= response.status_code < 300:
        logger.error(
            "auth_event=backend_identity_failure request_id=%s status=%d category=unexpected_backend_status",
            request_id,
            response.status_code,
        )
        raise HTTPException(
            status_code=502,
            detail="Authentication service returned an unexpected response.",
        )
    try:
        identity = response.json()
    except ValueError as error:
        logger.error(
            "auth_event=backend_identity_failure request_id=%s category=invalid_backend_json",
            request_id,
        )
        raise HTTPException(
            status_code=502,
            detail="Authentication service returned an invalid response.",
        ) from error
    if (
        not isinstance(identity, dict)
        or isinstance(identity.get("id"), bool)
        or not isinstance(identity.get("id"), int)
        or any(not isinstance(identity.get(field), str) for field in ("email", "name", "role"))
    ):
        logger.error(
            "auth_event=backend_identity_failure request_id=%s category=invalid_identity_schema",
            request_id,
        )
        raise HTTPException(
            status_code=502,
            detail="Authentication service returned an invalid identity.",
        )
    identity["token"] = token
    logger.info(
        "auth_event=identity_resolved request_id=%s stage=public_api",
        request_id,
    )
    return identity


async def _authenticate_cognito(token: str, request_id: str) -> dict:
    """Cryptographically validate a Cognito access token, then resolve identity.

    Fail-closed: a Cognito token that does not validate is rejected here and is
    never forwarded or downgraded to the legacy path.
    """
    try:
        verifier = get_verifier()
    except CognitoConfigurationError as error:
        logger.error(
            "auth_event=token_verification_failure request_id=%s stage=public_api category=configuration_missing",
            request_id,
        )
        raise HTTPException(
            status_code=500, detail="Cognito authentication is not configured."
        ) from error
    try:
        verifier.verify_access_token(token)
    except CognitoVerificationUnavailable as error:
        logger.error(
            "auth_event=token_verification_failure request_id=%s stage=public_api category=jwks_unavailable",
            request_id,
        )
        raise HTTPException(
            status_code=503, detail="Cognito authentication is temporarily unavailable."
        ) from error
    except CognitoTokenError as error:
        logger.warning(
            "auth_event=token_verification_failure request_id=%s stage=public_api category=invalid_token",
            request_id,
        )
        raise _unauthorized("Invalid or expired sign-in token.") from error
    # Token is valid; resolve role/email/id from the backend (DB-authoritative).
    return await _resolve_identity_from_backend(token, request_id)


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """Resolve the caller's identity according to AUTH_MODE (default 'legacy').

    - legacy : HS256 app token only (unchanged behaviour).
    - cognito: Cognito access token only; legacy tokens rejected.
    - dual   : a Cognito-issuer token is validated as Cognito (fail-closed, no
               downgrade); any other token is validated as legacy HS256.
    The raw token is always stashed as user["token"] for forwarding.
    """
    if credentials is None:
        raise _unauthorized("Sign-in required.")
    token = credentials.credentials
    request_id = getattr(request.state, "request_id", None) or uuid.uuid4().hex
    mode = get_auth_mode()

    if mode == AUTH_MODE_LEGACY:
        return _authenticate_legacy(token)
    if mode == AUTH_MODE_COGNITO:
        return await _authenticate_cognito(token, request_id)

    # dual
    if looks_like_cognito_token(token):
        return await _authenticate_cognito(token, request_id)
    return _authenticate_legacy(token)


def require_roles(*allowed_roles):
    async def dependency(user=Depends(get_current_user)):
        if user["role"] not in allowed_roles:
            raise HTTPException(status_code=403, detail="You do not have permission for this action.")
        return user

    return dependency
