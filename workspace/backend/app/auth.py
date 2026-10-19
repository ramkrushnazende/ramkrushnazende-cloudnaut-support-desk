import logging
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone

import boto3
import jwt
from botocore.exceptions import ClientError
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pwdlib import PasswordHash

from app.cognito import (
    AUTH_MODE_COGNITO,
    AUTH_MODE_DUAL,
    AUTH_MODE_LEGACY,
    CognitoConfigurationError,
    CognitoTokenError,
    CognitoVerificationUnavailable,
    get_auth_mode,
    get_verifier,
    looks_like_cognito_token,
)
from database.app.database import get_db
from database.app.models import SecuritySetting, TeamMember


JWT_SECRET = os.getenv("AUTH_SECRET_KEY", "")
JWT_ALGORITHM = "HS256"
TOKEN_LIFETIME = timedelta(hours=8)
password_hash = PasswordHash.recommended()
bearer_scheme = HTTPBearer(auto_error=False)
logger = logging.getLogger(__name__)


def _request_id(request: Request) -> str:
    candidate = request.headers.get("x-request-id", "")
    return candidate if re.fullmatch(r"[0-9a-f]{32}", candidate) else uuid.uuid4().hex


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def verify_password(plain_password: str, stored_hash: str | None) -> bool:
    if not stored_hash:
        return False
    return password_hash.verify(plain_password, stored_hash)


def hash_password(plain_password: str) -> str:
    return password_hash.hash(plain_password)


def create_access_token(member) -> str:
    if not JWT_SECRET:
        raise RuntimeError("AUTH_SECRET_KEY must be configured.")
    now = datetime.now(timezone.utc)
    return jwt.encode(
        {
            "sub": str(member.id),
            "email": member.email,
            "name": member.name,
            "role": member.role,
            "iat": now,
            "exp": now + TOKEN_LIFETIME,
        },
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


def _member_identity(member: "TeamMember") -> dict:
    """The authoritative identity dict used by all RBAC checks + the profile UI.

    Role and active status always come from PostgreSQL, never from a token.
    phone_number and mfa_enabled are profile fields surfaced to the account UI;
    mfa_enabled is a display mirror of Cognito's MFA status (not an auth input).
    """
    return {
        "id": member.id,
        "email": member.email,
        "name": member.name,
        "role": member.role,
        "phone_number": member.phone_number,
        "mfa_enabled": member.mfa_enabled,
    }


def _staff_mfa_required(db) -> bool:
    setting = db.query(SecuritySetting).filter(SecuritySetting.id == 1).first()
    return bool(setting and setting.require_staff_mfa)


def cognito_mfa_enabled(access_token: str, expected_sub: str | None = None) -> bool:
    """Return live Cognito TOTP enrollment state for a validated session.

    This deliberately calls Cognito GetUser instead of trusting the database
    display mirror or browser state. All failures are surfaced fail-closed.
    """
    if not access_token:
        raise _unauthorized("Sign-in required.")
    try:
        response = boto3.client(
            "cognito-idp",
            region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
        ).get_user(AccessToken=access_token)
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code in {"NotAuthorizedException", "UserNotFoundException"}:
            raise _unauthorized("Invalid or expired sign-in token.") from error
        logger.error("auth_event=mfa_status_failure category=cognito_get_user error_code=%s", code or "unknown")
        raise HTTPException(status_code=503, detail="MFA status is temporarily unavailable.") from error
    except Exception as error:
        logger.error("auth_event=mfa_status_failure category=cognito_get_user error_type=%s", type(error).__name__)
        raise HTTPException(status_code=503, detail="MFA status is temporarily unavailable.") from error

    attributes = {
        item["Name"]: item["Value"]
        for item in response.get("UserAttributes", [])
        if isinstance(item, dict) and "Name" in item and "Value" in item
    }
    if expected_sub and attributes.get("sub") != expected_sub:
        logger.warning("auth_event=mfa_status_failure category=subject_mismatch")
        raise HTTPException(status_code=403, detail="Your account is not linked or authorized.")
    return "SOFTWARE_TOKEN_MFA" in response.get("UserMFASettingList", [])


def mfa_requirement_status(user: dict, access_token: str, db) -> dict:
    enforced = _staff_mfa_required(db)
    staff_member = user.get("role") in {"employee", "support"}
    member = db.query(TeamMember).filter(TeamMember.id == user.get("id")).first()
    cognito_sub = member.cognito_sub if member else None
    if not enforced or not staff_member:
        return {
            "mfa_required": False,
            "mfa_enrolled": bool(user.get("mfa_enabled")) if user.get("role") != "admin" else None,
            "mfa_enforcement_enabled": enforced,
        }
    if get_auth_mode() == AUTH_MODE_LEGACY or not cognito_sub:
        raise HTTPException(
            status_code=503,
            detail="MFA enforcement is unavailable for this account configuration.",
        )
    enrolled = cognito_mfa_enabled(access_token, expected_sub=cognito_sub)
    return {
        "mfa_required": not enrolled,
        "mfa_enrolled": enrolled,
        "mfa_enforcement_enabled": True,
    }


def _authenticate_legacy(token: str, db) -> dict:
    """Validate the existing HS256 app token and load the user from the DB."""
    if not JWT_SECRET:
        raise HTTPException(status_code=500, detail="Authentication is not configured.")
    try:
        claims = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        member = db.query(TeamMember).filter(TeamMember.id == int(claims["sub"])).first()
    except (jwt.InvalidTokenError, KeyError, TypeError, ValueError) as error:
        raise _unauthorized("Invalid or expired sign-in token.") from error
    if not member or not member.is_active:
        raise _unauthorized("Account is inactive or unavailable.")
    return _member_identity(member)


def _authenticate_cognito(token: str, db, request_id: str) -> dict:
    """Validate a Cognito access token and map its `sub` to a team_members row.

    Token failures are rejected; signing-key outages and missing configuration
    retain service-error statuses. Role and active status are read from
    PostgreSQL via the stable `cognito_sub` mapping — token claims are never
    trusted for authorization, and users are never auto-provisioned.
    """
    try:
        verifier = get_verifier()
    except CognitoConfigurationError as error:
        logger.error(
            "auth_event=token_verification_failure request_id=%s stage=backend category=configuration_missing",
            request_id,
        )
        # Cognito requested but not configured: do not fall back, fail closed.
        raise HTTPException(
            status_code=500, detail="Cognito authentication is not configured."
        ) from error
    try:
        verified = verifier.verify_access_token(token)
    except CognitoVerificationUnavailable as error:
        logger.error(
            "auth_event=token_verification_failure request_id=%s stage=backend category=jwks_unavailable",
            request_id,
        )
        raise HTTPException(
            status_code=503, detail="Cognito authentication is temporarily unavailable."
        ) from error
    except CognitoTokenError as error:
        logger.warning(
            "auth_event=token_verification_failure request_id=%s stage=backend category=invalid_token",
            request_id,
        )
        raise _unauthorized("Invalid or expired sign-in token.") from error

    member = (
        db.query(TeamMember).filter(TeamMember.cognito_sub == verified.sub).first()
    )
    if member is None:
        logger.warning(
            "auth_event=identity_mapping_failure request_id=%s stage=backend category=not_linked",
            request_id,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account is not linked or authorized.",
        )
    if not member.is_active:
        logger.warning(
            "auth_event=identity_mapping_failure request_id=%s stage=backend category=inactive",
            request_id,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account is not active or authorized.",
        )
    logger.info(
        "auth_event=identity_resolved request_id=%s stage=backend",
        request_id,
    )
    return _member_identity(member)


def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db=Depends(get_db),
):
    """Resolve the authenticated user according to AUTH_MODE (default 'legacy').

    - legacy : HS256 app token only (unchanged behaviour).
    - cognito: Cognito access token only; legacy tokens rejected.
    - dual   : a token whose issuer points at Cognito is validated as a Cognito
               token (and fails closed if invalid — never downgraded); any other
               token is validated as a legacy HS256 token.
    """
    if credentials is None:
        raise _unauthorized("Sign-in required.")
    token = credentials.credentials
    request_id = _request_id(request)
    mode = get_auth_mode()

    if mode == AUTH_MODE_LEGACY:
        return _authenticate_legacy(token, db)
    if mode == AUTH_MODE_COGNITO:
        return _authenticate_cognito(token, db, request_id)

    # dual: route by (unverified) issuer so a Cognito token can never be
    # silently downgraded to the legacy path on validation failure.
    if looks_like_cognito_token(token):
        return _authenticate_cognito(token, db, request_id)
    return _authenticate_legacy(token, db)


def require_mfa(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    user=Depends(get_current_user),
    db=Depends(get_db),
):
    if user.get("role") == "admin" or not _staff_mfa_required(db):
        return user
    member = db.query(TeamMember).filter(TeamMember.id == user.get("id")).first()
    if get_auth_mode() == AUTH_MODE_LEGACY or not member or not member.cognito_sub:
        raise HTTPException(
            status_code=403,
            detail="MFA enforcement requires a linked Cognito account.",
        )
    enrolled = cognito_mfa_enabled(credentials.credentials if credentials else "", expected_sub=member.cognito_sub)
    if not enrolled:
        raise HTTPException(
            status_code=403,
            detail="Complete MFA enrollment before accessing support data.",
            headers={"X-MFA-Required": "true"},
        )
    return user


def require_roles(*allowed_roles):
    def dependency(user=Depends(require_mfa)):
        if user["role"] not in allowed_roles:
            raise HTTPException(status_code=403, detail="You do not have permission for this action.")
        return user

    return dependency