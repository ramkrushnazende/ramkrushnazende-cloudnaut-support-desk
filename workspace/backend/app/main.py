import hashlib
import logging
import os
import secrets
import smtplib
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from urllib.parse import quote

import boto3
from botocore.exceptions import ClientError
from fastapi import FastAPI, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from typing import Any, Dict, Literal

from app.auth import (
    create_access_token,
    get_current_user,
    hash_password,
    mfa_requirement_status,
    require_mfa,
    require_roles,
    verify_password,
)
from app.cognito import (
    CognitoConfigurationError,
    CognitoTokenError,
    CognitoVerificationUnavailable,
    get_auth_mode,
    get_verifier,
)
from app.routers.attachments import router as attachments_router
from database.app.database import get_db
from database.app.models import AccessRequest, PasswordResetToken, SecuritySetting, TeamMember
from app.services.ticket_notifications import (
    TicketNotificationError,
    send_ticket_confirmation_email,
)

app = FastAPI(title="Cloudnaut Support Desk Backend Service")
app.include_router(attachments_router)
logger = logging.getLogger(__name__)


def send_password_reset_email(email, name, token):
    smtp_host = os.getenv("SMTP_HOST")
    from_email = os.getenv("SMTP_FROM_EMAIL")
    if not smtp_host or not from_email:
        raise RuntimeError("SMTP_HOST and SMTP_FROM_EMAIL must be configured.")

    smtp_port = int(os.getenv("SMTP_PORT", "587"))
    frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")
    reset_url = f"{frontend_url}/?reset_token={quote(token)}"
    message = EmailMessage()
    message["Subject"] = "Reset your Cloudnaut Support Desk password"
    message["From"] = from_email
    message["To"] = email
    message.set_content(
        f"Hello {name},\n\nUse this link to reset your password. "
        f"It expires in 30 minutes and can only be used once:\n\n{reset_url}\n"
    )

    smtp_use_tls = os.getenv("SMTP_USE_TLS", "false").lower() == "true"

    smtp_class = smtplib.SMTP_SSL if smtp_port == 465 else smtplib.SMTP
    with smtp_class(smtp_host, smtp_port, timeout=10) as smtp:
        if smtp_use_tls:
            smtp.starttls()
        username = os.getenv("SMTP_USERNAME")
        if username:
            smtp.login(username, os.getenv("SMTP_PASSWORD", ""))
        smtp.send_message(message)


def member_response(member):
    return {
        "id": member.id,
        "name": member.name,
        "email": member.email,
        "is_active": member.is_active,
        "role": member.role,
    }


def access_request_response(request, provisioning_status=None):
    response = {
        "id": request.id,
        "name": request.name,
        "email": request.email,
        "role": request.role,
        "message": request.message,
        "status": request.status,
        "created_at": request.created_at,
        "reviewed_at": request.reviewed_at,
        "reviewed_by": request.reviewed_by,
        "review_note": request.review_note,
        "email_verified": bool(request.cognito_sub),
    }
    if provisioning_status:
        response["provisioning_status"] = provisioning_status
    return response


class AccessRequestPayload(BaseModel):
    role: Literal["employee", "support"]
    message: str | None = Field(default=None, max_length=1000)

def get_verified_signup_identity(access_token: str) -> dict[str, str]:
    """Validate the access token and fetch its verified Cognito profile."""
    try:
        claims = get_verifier().verify_access_token(access_token)
    except CognitoConfigurationError as error:
        raise HTTPException(
            status_code=500, detail="Cognito authentication is not configured."
        ) from error
    except CognitoVerificationUnavailable as error:
        raise HTTPException(
            status_code=503, detail="Cognito authentication is temporarily unavailable."
        ) from error
    except CognitoTokenError as error:
        logger.warning(
            "auth_event=signup_identity_rejected category=token_validation"
        )
        raise HTTPException(status_code=401, detail="Invalid or expired sign-in token.") from error

    try:
        client = boto3.client(
            "cognito-idp",
            region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
        )
        response = client.get_user(AccessToken=access_token)
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        logger.warning(
            "auth_event=signup_identity_rejected category=cognito_get_user error_code=%s",
            code or "unknown",
        )
        if code in {"NotAuthorizedException", "UserNotFoundException"}:
            raise HTTPException(
                status_code=401, detail="Invalid or expired sign-in token."
            ) from error
        raise HTTPException(
            status_code=503, detail="Cognito profile verification is temporarily unavailable."
        ) from error
    except Exception as error:
        logger.error(
            "auth_event=signup_identity_failure category=cognito_get_user error_type=%s",
            type(error).__name__,
        )
        raise HTTPException(
            status_code=503, detail="Cognito profile verification is temporarily unavailable."
        ) from error

    attributes = {
        item["Name"]: item["Value"]
        for item in response.get("UserAttributes", [])
        if isinstance(item, dict) and "Name" in item and "Value" in item
    }
    email = attributes.get("email", "").strip().lower()
    name = attributes.get("name", "").strip()
    if (
        attributes.get("sub") != claims.sub
        or not email
        or attributes.get("email_verified", "").lower() != "true"
        or not name
    ):
        logger.warning(
            "auth_event=signup_identity_rejected category=unverified_or_mismatched_profile"
        )
        raise HTTPException(
            status_code=403,
            detail="Verify your Cognito email and profile before requesting access.",
        )
    return {"sub": claims.sub, "email": email, "name": name}


@app.get("/health", status_code=status.HTTP_200_OK)
def health_check():
    return {"status": "healthy", "service": "support-desk-backend"}


@app.get("/internal/auth/whoami")
def whoami(
    authorization: str | None = Header(default=None, alias="Authorization"),
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return identity plus server-computed MFA enforcement state.

    This endpoint remains available before enrollment so the SPA can render the
    enrollment gate. Business endpoints use require_mfa and cannot be bypassed
    by changing frontend state.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign-in required.")
    access_token = authorization[7:].strip()
    if not access_token:
        raise HTTPException(status_code=401, detail="Sign-in required.")
    return {**user, **mfa_requirement_status(user, access_token, db)}


class MfaPolicyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    require_staff_mfa: bool


def _mfa_policy_response(setting: SecuritySetting) -> dict:
    return {
        "require_staff_mfa": bool(setting.require_staff_mfa),
        "updated_at": setting.updated_at,
        "updated_by": setting.updated_by,
    }


@app.get("/internal/security/mfa-policy")
def get_mfa_policy(
    db: Session = Depends(get_db),
    user=Depends(require_roles("admin")),
):
    setting = db.query(SecuritySetting).filter(SecuritySetting.id == 1).first()
    if setting is None:
        setting = SecuritySetting(id=1, require_staff_mfa=False, updated_by=user["id"])
        db.add(setting)
        db.commit()
        db.refresh(setting)
    return _mfa_policy_response(setting)


@app.patch("/internal/security/mfa-policy")
def update_mfa_policy(
    payload: MfaPolicyUpdate,
    db: Session = Depends(get_db),
    user=Depends(require_roles("admin")),
):
    if payload.require_staff_mfa and get_auth_mode() == "legacy":
        raise HTTPException(
            status_code=409,
            detail="MFA enforcement requires Cognito authentication mode.",
        )
    if payload.require_staff_mfa:
        unlinked = db.query(TeamMember).filter(
            TeamMember.is_active.is_(True),
            TeamMember.role.in_(["employee", "support"]),
            TeamMember.cognito_sub.is_(None),
        ).count()
        if unlinked:
            raise HTTPException(
                status_code=409,
                detail="Link all active employees and support staff to Cognito before enabling MFA enforcement.",
            )
    setting = db.query(SecuritySetting).filter(SecuritySetting.id == 1).first()
    if setting is None:
        setting = SecuritySetting(id=1)
        db.add(setting)
    setting.require_staff_mfa = payload.require_staff_mfa
    setting.updated_by = user["id"]
    db.commit()
    db.refresh(setting)
    logger.info(
        "security_event=mfa_policy_updated admin_id=%s require_staff_mfa=%s",
        user["id"],
        payload.require_staff_mfa,
    )
    return _mfa_policy_response(setting)


@app.post("/internal/profile/phone")
def sync_verified_profile_phone(
    authorization: str | None = Header(default=None, alias="Authorization"),
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Persist only the phone number Cognito confirms as verified for this user."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign-in required.")
    access_token = authorization[7:].strip()
    if not access_token:
        raise HTTPException(status_code=401, detail="Sign-in required.")

    member = db.query(TeamMember).filter(TeamMember.id == user["id"]).first()
    if not member or not member.is_active or not member.cognito_sub:
        raise HTTPException(status_code=403, detail="Your account is not linked or authorized.")

    try:
        response = boto3.client(
            "cognito-idp",
            region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
        ).get_user(AccessToken=access_token)
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        logger.warning(
            "auth_event=phone_profile_sync_failed category=cognito_get_user error_code=%s",
            code or "unknown",
        )
        if code in {"NotAuthorizedException", "UserNotFoundException"}:
            raise HTTPException(status_code=401, detail="Invalid or expired sign-in token.") from error
        raise HTTPException(
            status_code=503, detail="Phone verification could not be confirmed right now."
        ) from error
    except Exception as error:
        logger.error(
            "auth_event=phone_profile_sync_failed category=cognito_get_user error_type=%s",
            type(error).__name__,
        )
        raise HTTPException(
            status_code=503, detail="Phone verification could not be confirmed right now."
        ) from error

    attributes = {
        item["Name"]: item["Value"]
        for item in response.get("UserAttributes", [])
        if isinstance(item, dict) and "Name" in item and "Value" in item
    }
    phone_number = attributes.get("phone_number", "")
    if attributes.get("sub") != member.cognito_sub:
        logger.warning("auth_event=phone_profile_sync_failed category=subject_mismatch")
        raise HTTPException(status_code=403, detail="Your account is not linked or authorized.")
    if attributes.get("phone_number_verified", "").lower() != "true":
        raise HTTPException(status_code=409, detail="Verify your phone number before saving it.")
    if (
        len(phone_number) < 9
        or len(phone_number) > 16
        or not phone_number.startswith("+")
        or not phone_number[1:].isdigit()
        or phone_number[1] == "0"
    ):
        logger.warning("auth_event=phone_profile_sync_failed category=invalid_verified_phone")
        raise HTTPException(status_code=400, detail="Cognito returned an invalid verified phone number.")

    member.phone_number = phone_number
    db.commit()
    logger.info("auth_event=phone_profile_sync_succeeded member_id=%s", member.id)
    return {"phone_number": member.phone_number, "phone_verified": True}


@app.post("/internal/profile/mfa")
def sync_profile_mfa_status(
    authorization: str | None = Header(default=None, alias="Authorization"),
    user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Return the verified software-token MFA preference for this user."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign-in required.")
    access_token = authorization[7:].strip()
    if not access_token:
        raise HTTPException(status_code=401, detail="Sign-in required.")

    member = db.query(TeamMember).filter(TeamMember.id == user["id"]).first()
    if not member or not member.is_active or not member.cognito_sub:
        raise HTTPException(status_code=403, detail="Your account is not linked or authorized.")

    try:
        response = boto3.client(
            "cognito-idp",
            region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION"),
        ).get_user(AccessToken=access_token)
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        logger.warning(
            "auth_event=mfa_profile_sync_failed category=cognito_get_user error_code=%s",
            code or "unknown",
        )
        if code in {"NotAuthorizedException", "UserNotFoundException"}:
            raise HTTPException(status_code=401, detail="Invalid or expired sign-in token.") from error
        raise HTTPException(
            status_code=503, detail="Authenticator status could not be confirmed right now."
        ) from error
    except Exception as error:
        logger.error(
            "auth_event=mfa_profile_sync_failed category=cognito_get_user error_type=%s",
            type(error).__name__,
        )
        raise HTTPException(
            status_code=503, detail="Authenticator status could not be confirmed right now."
        ) from error

    attributes = {
        item["Name"]: item["Value"]
        for item in response.get("UserAttributes", [])
        if isinstance(item, dict) and "Name" in item and "Value" in item
    }
    if attributes.get("sub") != member.cognito_sub:
        logger.warning("auth_event=mfa_profile_sync_failed category=subject_mismatch")
        raise HTTPException(status_code=403, detail="Your account is not linked or authorized.")

    mfa_enabled = "SOFTWARE_TOKEN_MFA" in response.get("UserMFASettingList", [])
    logger.info(
        "auth_event=mfa_profile_sync_succeeded member_id=%s mfa_enabled=%s",
        member.id,
        mfa_enabled,
    )
    return {"mfa_enabled": mfa_enabled}


@app.post("/internal/auth/login")
def login(payload: Dict[str, Any], db: Session = Depends(get_db)):
    email = str(payload.get("email", "")).strip().lower()
    password = payload.get("password")
    member = db.query(TeamMember).filter(TeamMember.email.ilike(email)).first()
    if not member or not member.is_active or not verify_password(password or "", member.password_hash):
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    return {"access_token": create_access_token(member), "token_type": "bearer", "user": member_response(member)}


@app.post("/internal/auth/forgot-password")
def forgot_password(payload: Dict[str, Any], db: Session = Depends(get_db)):
    email = str(payload.get("email", "")).strip().lower()
    if "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required.")

    if not os.getenv("SMTP_HOST") or not os.getenv("SMTP_FROM_EMAIL"):
        raise HTTPException(status_code=503, detail="Password reset email is not configured.")

    member = db.query(TeamMember).filter(TeamMember.email.ilike(email), TeamMember.is_active.is_(True)).first()
    if member:
        raw_token = secrets.token_urlsafe(32)
        token_record = PasswordResetToken(
            user_id=member.id,
            token_hash=hashlib.sha256(raw_token.encode()).hexdigest(),
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=30),
        )
        db.add(token_record)
        db.commit()
        try:
            send_password_reset_email(member.email, member.name, raw_token)
        except (OSError, smtplib.SMTPException, RuntimeError) as error:
            logger.exception("Could not send a password reset email")
            token_record.used_at = datetime.now(timezone.utc)
            db.commit()

    return {"message": "If an active user uses that email, password reset instructions have been sent."}


@app.post("/internal/auth/reset-password")
def reset_password(payload: Dict[str, Any], db: Session = Depends(get_db)):
    raw_token = payload.get("token")
    password = payload.get("password")
    if not isinstance(raw_token, str) or not raw_token or not isinstance(password, str) or len(password) < 6:
        raise HTTPException(status_code=400, detail="A valid reset token and a password of at least 6 characters are required.")
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    token_record = db.query(PasswordResetToken).filter(PasswordResetToken.token_hash == token_hash).first()
    now = datetime.now(timezone.utc)
    expires_at = token_record.expires_at.replace(tzinfo=timezone.utc) if token_record and token_record.expires_at.tzinfo is None else (token_record.expires_at if token_record else None)
    if not token_record or token_record.used_at or expires_at <= now:
        raise HTTPException(status_code=400, detail="This password reset link is invalid or expired.")

    member = db.query(TeamMember).filter(TeamMember.id == token_record.user_id, TeamMember.is_active.is_(True)).first()
    if not member:
        raise HTTPException(status_code=400, detail="This password reset link is invalid or expired.")

    member.password_hash = hash_password(password)
    token_record.used_at = now
    for previous_token in db.query(PasswordResetToken).filter(
        PasswordResetToken.user_id == member.id,
        PasswordResetToken.used_at.is_(None),
        PasswordResetToken.id != token_record.id,
    ):
        previous_token.used_at = now
    db.commit()
    return {"message": "Password updated. You can now sign in."}


@app.post("/internal/requests", status_code=status.HTTP_201_CREATED)
def create_internal_request(
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    user=Depends(require_roles("employee", "support", "admin")),
):
    if user["role"] == "employee" and str(payload.get("requester_email", "")).lower() != user["email"].lower():
        raise HTTPException(status_code=403, detail="Employees can only submit tickets for their own account.")
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService

    try:
        repository = RequestRepository(db)
        service = RequestService(repository)
        result = service.create_request(payload)
        repository.add_history_event(
            result["id"],
            "created",
            f"Request created by {result['requester_name']}",
        )
        try:
            send_ticket_confirmation_email(result)
        except TicketNotificationError as error:
            logger.error(
                "ticket_notification_failed ticket_id=%s category=confirmation_email error=%s",
                result.get("id"),
                error,
            )
        return result
    except ValueError as err:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(err),
        )
    except Exception as err:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Internal Server Error: {str(err)}",
        )


@app.get("/internal/requests/{request_id}", status_code=status.HTTP_200_OK)
def get_internal_request(
    request_id: int,
    db: Session = Depends(get_db),
    user=Depends(require_mfa),
):
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService

    repository = RequestRepository(db)
    service = RequestService(repository)
    try:
        req = service.get_request_by_id(request_id)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    if not req:
        raise HTTPException(status_code=404, detail=f"Request {request_id} not found")
    if user["role"] == "employee" and req.requester_email.lower() != user["email"].lower():
        raise HTTPException(status_code=404, detail=f"Request {request_id} not found")
    return repository._request_to_dict(req)


@app.patch("/internal/requests/{request_id}", status_code=status.HTTP_200_OK)
def update_internal_request(
    request_id: int,
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    user=Depends(require_roles("support", "admin")),
):
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService

    try:
        repository = RequestRepository(db)
        return RequestService(repository).update_request(request_id, payload)
    except LookupError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@app.get("/internal/team-members", status_code=status.HTTP_200_OK)
def list_internal_team_members(
    active_only: bool = False,
    db: Session = Depends(get_db),
    user=Depends(require_roles("support", "admin")),
):
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService

    return [
        {
            "id": member.id,
            "name": member.name,
            "email": member.email,
            "is_active": member.is_active,
            "role": member.role,
        }
        for member in RequestService(RequestRepository(db)).list_team_members(active_only)
    ]


@app.get("/internal/requests", status_code=status.HTTP_200_OK)
def list_internal_requests(
    status_filter: str | None = Query(default=None, alias="status"),
    assigned_to: int | None = None,
    assignment: str | None = None,
    category: str | None = None,
    priority: str | None = None,
    created_from: str | None = None,
    created_to: str | None = None,
    sort_by: str = Query(default="created_at"),
    sort_order: str = Query(default="desc"),
    db: Session = Depends(get_db),
    user=Depends(require_mfa),
):
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService

    try:
        repository = RequestRepository(db)
        requests = RequestService(repository).list_requests(
            status=status_filter,
            assigned_to=assigned_to,
            assignment=assignment,
            category=category,
            priority=priority,
            created_from=created_from,
            created_to=created_to,
            requester_email=user["email"] if user["role"] == "employee" else None,
            sort_by=sort_by,
            sort_order=sort_order,
        )
        return [repository._request_to_dict(request) for request in requests]
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@app.patch("/internal/requests/{request_id}/assignment", status_code=status.HTTP_200_OK)
def assign_internal_request(
    request_id: int,
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    user=Depends(require_roles("support", "admin")),
):
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService

    try:
        repository = RequestRepository(db)
        service = RequestService(repository)
        result = service.assign_request(request_id, payload.get("assigned_to"))
        repository.add_history_event(
            request_id,
            "assignment",
            "Request unassigned"
            if result["assigned_to"] is None
            else f"Request assigned to team member {result['assigned_to']}",
        )
        return result
    except LookupError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@app.patch("/internal/requests/{request_id}/status", status_code=status.HTTP_200_OK)
def transition_internal_request(
    request_id: int,
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    user=Depends(require_roles("support", "admin")),
):
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService

    new_status = payload.get("status")
    if not isinstance(new_status, str):
        raise HTTPException(status_code=400, detail="Status is required.")
    try:
        repository = RequestRepository(db)
        result = RequestService(repository).transition_status(request_id, new_status)
        repository.add_history_event(
            request_id,
            "status_change",
            f"Request status changed to {new_status}",
        )
        return result
    except LookupError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@app.get("/internal/requests/{request_id}/history", status_code=status.HTTP_200_OK)
def get_request_history(
    request_id: int,
    db: Session = Depends(get_db),
    user=Depends(require_roles("support", "admin")),
):
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService
    from app.services.history_service import HistoryService

    service = RequestService(RequestRepository(db))
    if not service.get_request_by_id(request_id):
        raise HTTPException(status_code=404, detail=f"Request {request_id} not found")
    return HistoryService(service.repository).list(request_id)


@app.post("/internal/requests/{request_id}/notes", status_code=status.HTTP_201_CREATED)
def add_request_note(
    request_id: int,
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    user=Depends(require_roles("support", "admin")),
):
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService
    from app.services.history_service import HistoryService

    try:
        repository = RequestRepository(db)
        RequestService(repository)._get_request(request_id)
        note = HistoryService(repository).add_note(
            request_id, payload.get("note", ""), user["name"],
            is_public=bool(payload.get("is_public", False)),
        )
        repository.add_history_event(
            request_id,
            "note",
            "Progress update shared with requester" if note["is_public"] else "Internal note added",
        )
        return note
    except LookupError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err


@app.get("/internal/requests/{request_id}/notes", status_code=status.HTTP_200_OK)
def get_request_notes(
    request_id: int,
    db: Session = Depends(get_db),
    user=Depends(require_mfa),
):
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService
    from app.services.history_service import HistoryService

    repository = RequestRepository(db)
    request = RequestService(repository).get_request_by_id(request_id)
    if not request:
        raise HTTPException(status_code=404, detail=f"Request {request_id} not found")
    if user["role"] == "employee":
        if request.requester_email.lower() != user["email"].lower():
            raise HTTPException(status_code=404, detail=f"Request {request_id} not found")
        return [note for note in HistoryService(repository).list_notes(request_id) if note.is_public]
    return HistoryService(repository).list_notes(request_id)


@app.get("/internal/progress-updates", status_code=status.HTTP_200_OK)
def get_employee_progress_updates(
    db: Session = Depends(get_db),
    user=Depends(require_roles("employee")),
):
    from app.repositories.request_repository import RequestRepository

    return RequestRepository(db).list_public_updates(user["email"])


@app.get("/internal/dashboard", status_code=status.HTTP_200_OK)
def get_dashboard(
    db: Session = Depends(get_db),
    user=Depends(require_roles("support", "admin")),
):
    from app.repositories.request_repository import RequestRepository

    return RequestRepository(db).dashboard()


@app.post("/internal/access-requests", status_code=status.HTTP_201_CREATED)
def create_access_request(
    payload: AccessRequestPayload,
    authorization: str | None = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign-in required.")
    access_token = authorization[7:].strip()
    if not access_token:
        raise HTTPException(status_code=401, detail="Sign-in required.")

    identity = get_verified_signup_identity(access_token)
    name = identity["name"]
    email = identity["email"]
    cognito_sub = identity["sub"]
    role = payload.role
    message = payload.message.strip() or None if payload.message else None
    existing_member = db.query(TeamMember).filter(
        (TeamMember.cognito_sub == cognito_sub) | TeamMember.email.ilike(email)
    ).first()
    if existing_member:
        raise HTTPException(status_code=409, detail="An account with this email already exists.")

    existing_request = db.query(AccessRequest).filter(
        AccessRequest.email.ilike(email)
    ).order_by(AccessRequest.id.desc()).first()
    if existing_request:
        if (
            existing_request.status == "pending"
            and existing_request.cognito_sub == cognito_sub
            and existing_request.email.strip().lower() == email
            and existing_request.role == role
        ):
            return access_request_response(existing_request)
        if (
            existing_request.status == "pending"
            and existing_request.cognito_sub is None
            and existing_request.role == role
        ):
            existing_request.cognito_sub = cognito_sub
            existing_request.name = name
            try:
                db.commit()
            except IntegrityError as error:
                db.rollback()
                raise HTTPException(
                    status_code=409,
                    detail="An access request for this account already exists.",
                ) from error
            db.refresh(existing_request)
            return access_request_response(existing_request)
        raise HTTPException(
            status_code=409,
            detail="An access request for this account already exists or was reviewed.",
        )

    request = AccessRequest(
        name=name,
        email=email,
        cognito_sub=cognito_sub,
        role=role,
        password_hash=None,
        message=message,
    )
    db.add(request)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        existing_request = db.query(AccessRequest).filter(
            AccessRequest.cognito_sub == cognito_sub
        ).first()
        if (
            existing_request
            and existing_request.status == "pending"
            and existing_request.email.strip().lower() == email
            and existing_request.role == role
        ):
            return access_request_response(existing_request)
        raise HTTPException(
            status_code=409,
            detail="An access request for this account already exists.",
        ) from error
    db.refresh(request)
    logger.info("auth_event=access_request_created role=%s", role)
    return access_request_response(request)


@app.get("/internal/access-requests")
def list_access_requests(
    request_status: str = Query(default="pending", alias="status"),
    db: Session = Depends(get_db),
    user=Depends(require_roles("admin")),
):
    if request_status not in {"pending", "approved", "rejected"}:
        raise HTTPException(status_code=400, detail="Unsupported access request status.")
    requests = db.query(AccessRequest).filter(
        AccessRequest.status == request_status
    ).order_by(AccessRequest.created_at.desc(), AccessRequest.id.desc()).all()
    return [access_request_response(request) for request in requests]


@app.patch("/internal/access-requests/{access_request_id}")
def review_access_request(
    access_request_id: int,
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    user=Depends(require_roles("admin")),
):
    decision = payload.get("status")
    review_note = str(payload.get("review_note", "")).strip() or None
    if decision not in {"approved", "rejected"} or set(payload) - {"status", "review_note"}:
        raise HTTPException(status_code=400, detail="Choose approved or rejected and provide valid review fields.")
    if review_note and len(review_note) > 1000:
        raise HTTPException(status_code=400, detail="Review note must be 1000 characters or fewer.")
    request = db.query(AccessRequest).filter(AccessRequest.id == access_request_id).first()
    if not request:
        raise HTTPException(status_code=404, detail="Access request not found.")
    if request.status == "approved" and decision == "approved":
        return access_request_response(request, "already_approved")
    if request.status != "pending":
        raise HTTPException(status_code=409, detail="This access request has already been reviewed.")
    if decision == "approved":
        if not request.cognito_sub:
            raise HTTPException(
                status_code=409,
                detail="The requester must verify their Cognito email before approval.",
            )
        if request.role not in {"employee", "support"}:
            raise HTTPException(status_code=409, detail="This request has an invalid role.")
        existing_member = db.query(TeamMember).filter(
            (TeamMember.cognito_sub == request.cognito_sub)
            | TeamMember.email.ilike(request.email)
        ).first()
        if existing_member:
            raise HTTPException(
                status_code=409,
                detail="This email or Cognito identity is already linked to an application account.",
            )
        db.add(
            TeamMember(
                name=request.name,
                email=request.email.strip().lower(),
                role=request.role,
                password_hash=None,
                cognito_sub=request.cognito_sub,
                is_active=True,
            )
        )
    request.status = decision
    request.reviewed_at = datetime.now(timezone.utc)
    request.reviewed_by = user["id"]
    request.review_note = review_note
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="The account changed while this request was being reviewed.",
        ) from error
    db.refresh(request)
    logger.info(
        "auth_event=access_request_reviewed decision=%s role=%s",
        decision,
        request.role,
    )
    return access_request_response(
        request,
        "approved_and_linked" if decision == "approved" else None,
    )


@app.patch("/internal/team-members/{member_id}")
def update_team_member(
    member_id: int,
    payload: Dict[str, Any],
    db: Session = Depends(get_db),
    user=Depends(require_roles("admin")),
):
    from app.repositories.request_repository import RequestRepository
    from app.services.request_service import RequestService

    allowed = {"name", "email", "role", "is_active", "password"}
    if not payload or set(payload) - allowed:
        raise HTTPException(status_code=400, detail="Provide valid account fields to update.")
    member = db.query(TeamMember).filter(TeamMember.id == member_id).first()
    if member is None:
        raise HTTPException(status_code=404, detail=f"Team member {member_id} not found.")
    if member.cognito_provisioning_id and member.cognito_sub is None:
        raise HTTPException(
            status_code=409,
            detail="This account has a pending Cognito invitation. Retry provisioning before editing it.",
        )
    fields = {}
    if "name" in payload:
        name = str(payload["name"]).strip()
        if not name or len(name) > 100:
            raise HTTPException(status_code=400, detail="Name must be between 1 and 100 characters.")
        fields["name"] = name
    if "email" in payload:
        email = str(payload["email"]).strip().lower()
        if "@" not in email:
            raise HTTPException(status_code=400, detail="A valid email is required.")
        fields["email"] = email
    if "role" in payload:
        if payload["role"] not in {"admin", "support", "employee"}:
            raise HTTPException(status_code=400, detail="Role must be admin, support, or employee.")
        fields["role"] = payload["role"]
    if "is_active" in payload:
        if not isinstance(payload["is_active"], bool):
            raise HTTPException(status_code=400, detail="is_active must be a boolean.")
        fields["is_active"] = payload["is_active"]
    if "password" in payload:
        password = payload["password"]
        if not isinstance(password, str) or len(password) < 12:
            raise HTTPException(status_code=400, detail="Password must be at least 12 characters.")
        fields["password_hash"] = hash_password(password)
    if member_id == user["id"] and (
        fields.get("is_active") is False or fields.get("role", "admin") != "admin"
    ):
        raise HTTPException(status_code=400, detail="You cannot deactivate or demote your own account.")
    try:
        member = RequestService(RequestRepository(db)).update_team_member(member_id, fields)
        return member_response(member)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
