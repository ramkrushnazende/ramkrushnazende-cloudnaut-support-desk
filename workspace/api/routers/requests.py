import os

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from auth import get_current_user, require_roles
from schemas.access_requests import AccessRequestCreate, AccessRequestResponse, AccessRequestReview
from schemas.assignment import AssignmentRequest
from schemas.dashboard import DashboardSummary
from schemas.history import HistoryResponse
from schemas.note import NoteCreate, NoteResponse, ProgressUpdateResponse
from schemas.password_reset import PasswordResetConfirm, PasswordResetRequest
from schemas.request import TicketCreate, TicketResponse, TicketUpdate
from schemas.security import MfaPolicyResponse, MfaPolicyUpdate
from schemas.team_members import (
    LoginRequest,
    TeamMemberResponse,
    TeamMemberUpdate,
)
from schemas.status import StatusUpdate

router = APIRouter(prefix="/requests", tags=["Requests"])
team_router = APIRouter(tags=["Team Members"])

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8001")
BACKEND_TIMEOUT = float(os.getenv("BACKEND_TIMEOUT", "10"))

VALID_SORT_BY = {
    "created_at",
    "updated_at",
    "priority",
    "status",
    "title",
}

VALID_SORT_ORDER = {
    "asc",
    "desc",
}


async def backend_request(
    method: str,
    path: str,
    *,
    params: dict | None = None,
    json: dict | None = None,
    access_token: str | None = None,
):
    """
    Send request to internal backend service and forward
    backend HTTP errors to the public API.
    """
    try:
        async with httpx.AsyncClient(
            base_url=BACKEND_URL,
            timeout=BACKEND_TIMEOUT,
        ) as client:
            if method not in {"GET", "POST", "PATCH"}:
                raise RuntimeError(f"Unsupported backend HTTP method: {method}")
            headers = {"Authorization": f"Bearer {access_token}"} if access_token else None
            response = await client.request(
                method,
                path,
                params=params,
                json=json,
                headers=headers,
            )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail="Backend service is unavailable",
        ) from exc

    try:
        data = response.json()
    except ValueError:
        data = None

    if response.status_code >= 400:
        if isinstance(data, dict) and "detail" in data:
            detail = data["detail"]
        else:
            detail = "Backend request failed"

        raise HTTPException(
            status_code=response.status_code,
            detail=detail,
        )

    return data


# ---------------------------------------------------------
# CREATE REQUEST
# ---------------------------------------------------------

@router.post(
    "",
    response_model=TicketResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_ticket(
    ticket: TicketCreate,
    user=Depends(get_current_user),
):
    if user["role"] == "employee" and ticket.requester_email.lower() != user["email"].lower():
        raise HTTPException(status_code=403, detail="Employees can only submit tickets for their own account.")
    payload = ticket.model_dump(mode="json")

    data = await backend_request(
        "POST",
        "/internal/requests",
        json=payload,
        access_token=user["token"],
    )

    return data


# ---------------------------------------------------------
# LIST REQUESTS
# ---------------------------------------------------------

@router.get(
    "",
    response_model=list[TicketResponse],
)
async def list_requests(
    status_filter: str | None = Query(default=None, alias="status"),
    assigned_to: int | None = None,
    assignment: str | None = None,
    category: str | None = None,
    priority: str | None = None,
    created_from: str | None = None,
    created_to: str | None = None,
    sort_by: str = "created_at",
    sort_order: str = "desc",
    user=Depends(get_current_user),
):
    if assignment is not None and assignment not in {"assigned", "unassigned"}:
        raise HTTPException(status_code=400, detail="assignment must be 'assigned' or 'unassigned'.")
    if sort_by not in VALID_SORT_BY:
        raise HTTPException(
            status_code=400,
            detail="Invalid sort field.",
        )

    if sort_order not in VALID_SORT_ORDER:
        raise HTTPException(
            status_code=400,
            detail="Invalid sort order.",
        )

    params = {
        "status": status_filter,
        "assigned_to": assigned_to,
        "assignment": assignment,
        "category": category,
        "priority": priority,
        "created_from": created_from,
        "created_to": created_to,
        "sort_by": sort_by,
        "sort_order": sort_order,
    }

    params = {
        key: value
        for key, value in params.items()
        if value is not None
    }

    data = await backend_request(
        "GET",
        "/internal/requests",
        params=params,
        access_token=user["token"],
    )

    return data


# ---------------------------------------------------------
# GET REQUEST
# ---------------------------------------------------------

@router.get(
    "/{request_id}",
    response_model=TicketResponse,
)
async def get_request(request_id: int, user=Depends(get_current_user)):
    if request_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Request ID must be a positive integer.",
        )

    data = await backend_request(
        "GET",
        f"/internal/requests/{request_id}",
        access_token=user["token"],
    )

    if user["role"] == "employee" and data["requester_email"].lower() != user["email"].lower():
        raise HTTPException(status_code=404, detail=f"Request {request_id} not found.")

    return data


# ---------------------------------------------------------
# UPDATE REQUEST FIELDS
# ---------------------------------------------------------

@router.patch(
    "/{request_id}",
    response_model=TicketResponse,
)
async def update_ticket(
    request_id: int,
    ticket: TicketUpdate,
    user=Depends(require_roles("support", "admin")),
):
    if request_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Request ID must be a positive integer.",
        )

    payload = ticket.model_dump(
        mode="json",
        exclude_unset=True,
    )

    if not payload:
        raise HTTPException(
            status_code=400,
            detail="At least one field must be provided.",
        )

    data = await backend_request(
        "PATCH",
        f"/internal/requests/{request_id}",
        json=payload,
        access_token=user["token"],
    )

    return data


# ---------------------------------------------------------
# ASSIGN / UNASSIGN REQUEST
# ---------------------------------------------------------

@router.patch(
    "/{request_id}/assignment",
    response_model=TicketResponse,
)
async def update_assignment(
    request_id: int,
    assignment: AssignmentRequest,
    user=Depends(require_roles("support", "admin")),
):
    if request_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Request ID must be a positive integer.",
        )

    payload = assignment.model_dump(mode="json")

    data = await backend_request(
        "PATCH",
        f"/internal/requests/{request_id}/assignment",
        json=payload,
        access_token=user["token"],
    )

    return data


# ---------------------------------------------------------
# CHANGE STATUS
# ---------------------------------------------------------

@router.patch(
    "/{request_id}/status",
    response_model=TicketResponse,
)
async def update_status(
    request_id: int,
    status_update: StatusUpdate,
    user=Depends(require_roles("support", "admin")),
):
    if request_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Request ID must be a positive integer.",
        )

    payload = status_update.model_dump(mode="json")

    data = await backend_request(
        "PATCH",
        f"/internal/requests/{request_id}/status",
        json=payload,
        access_token=user["token"],
    )

    return data


# ---------------------------------------------------------
# ADD NOTE
# ---------------------------------------------------------

@router.post(
    "/{request_id}/notes",
    response_model=NoteResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_note(
    request_id: int,
    note: NoteCreate,
    user=Depends(require_roles("support", "admin")),
):
    if request_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Request ID must be a positive integer.",
        )

    payload = note.model_dump(mode="json")

    data = await backend_request(
        "POST",
        f"/internal/requests/{request_id}/notes",
        json=payload,
        access_token=user["token"],
    )

    return data


@router.get(
    "/{request_id}/notes",
    response_model=list[NoteResponse],
)
async def get_notes(
    request_id: int,
    user=Depends(get_current_user),
):
    if request_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Request ID must be a positive integer.",
        )

    return await backend_request(
        "GET",
        f"/internal/requests/{request_id}/notes",
        access_token=user["token"],
    )


# ---------------------------------------------------------
# GET HISTORY
# ---------------------------------------------------------

@router.get(
    "/{request_id}/history",
    response_model=list[HistoryResponse],
)
async def get_history(
    request_id: int,
    user=Depends(require_roles("support", "admin")),
):
    if request_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="Request ID must be a positive integer.",
        )

    data = await backend_request(
        "GET",
        f"/internal/requests/{request_id}/history",
        access_token=user["token"],
    )

    return data


# ---------------------------------------------------------
# GET TEAM MEMBERS
# ---------------------------------------------------------

@team_router.get(
    "/team-members",
    response_model=list[TeamMemberResponse],
)
async def get_team_members(
    active_only: bool = False,
    user=Depends(require_roles("support", "admin")),
):
    params = {
        "active_only": active_only,
    }

    data = await backend_request(
        "GET",
        "/internal/team-members",
        params=params,
        access_token=user["token"],
    )

    return data


@team_router.get(
    "/security/mfa-policy",
    response_model=MfaPolicyResponse,
)
async def get_mfa_policy(user=Depends(require_roles("admin"))):
    return await backend_request(
        "GET",
        "/internal/security/mfa-policy",
        access_token=user["token"],
    )


@team_router.patch(
    "/security/mfa-policy",
    response_model=MfaPolicyResponse,
)
async def update_mfa_policy(
    policy: MfaPolicyUpdate,
    user=Depends(require_roles("admin")),
):
    return await backend_request(
        "PATCH",
        "/internal/security/mfa-policy",
        json=policy.model_dump(mode="json"),
        access_token=user["token"],
    )


@team_router.post("/auth/login")
async def login(credentials: LoginRequest):
    return await backend_request(
        "POST",
        "/internal/auth/login",
        json=credentials.model_dump(mode="json"),
    )


def _strip_token_from_identity(user: dict) -> dict:
    return {k: v for k, v in user.items() if k != "token"}


@team_router.get("/auth/whoami")
@team_router.get("/auth/whami")
async def whoami(user=Depends(get_current_user)):
    """Return the DB-authoritative identity for the presented token.

    Used by the frontend after Cognito sign-in to resolve role/email/name from
    PostgreSQL (via the backend). get_current_user already validated the token
    and, in cognito/dual mode, resolved the identity through the backend. The
    raw token is stripped from the response.

    `/auth/whami` is kept as a compatibility alias for older frontend or
    gateway routes during the Cognito rollout.
    """
    return _strip_token_from_identity(user)


@team_router.post("/auth/forgot-password")
async def forgot_password(request: PasswordResetRequest):
    return await backend_request(
        "POST",
        "/internal/auth/forgot-password",
        json=request.model_dump(mode="json"),
    )


@team_router.post("/auth/reset-password")
async def reset_password(request: PasswordResetConfirm):
    return await backend_request(
        "POST",
        "/internal/auth/reset-password",
        json=request.model_dump(mode="json"),
    )


@team_router.post("/profile/phone")
async def sync_verified_profile_phone(user=Depends(get_current_user)):
    return await backend_request(
        "POST",
        "/internal/profile/phone",
        access_token=user["token"],
    )


@team_router.post("/profile/mfa")
async def sync_profile_mfa_status(user=Depends(get_current_user)):
    return await backend_request(
        "POST",
        "/internal/profile/mfa",
        access_token=user["token"],
    )


@team_router.post("/auth/signup", response_model=AccessRequestResponse, status_code=status.HTTP_201_CREATED)
async def signup(
    request: AccessRequestCreate,
    authorization: str | None = Header(default=None, alias="Authorization"),
):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Sign-in required.")
    access_token = authorization[7:].strip()
    if not access_token:
        raise HTTPException(status_code=401, detail="Sign-in required.")
    return await backend_request(
        "POST",
        "/internal/access-requests",
        json=request.model_dump(mode="json"),
        access_token=access_token,
    )


@team_router.get("/access-requests", response_model=list[AccessRequestResponse])
async def get_access_requests(
    request_status: str = Query(default="pending", alias="status"),
    user=Depends(require_roles("admin")),
):
    return await backend_request(
        "GET",
        "/internal/access-requests",
        params={"status": request_status},
        access_token=user["token"],
    )


@team_router.patch("/access-requests/{access_request_id}", response_model=AccessRequestResponse)
async def review_access_request(
    access_request_id: int,
    review: AccessRequestReview,
    user=Depends(require_roles("admin")),
):
    return await backend_request(
        "PATCH",
        f"/internal/access-requests/{access_request_id}",
        json=review.model_dump(mode="json"),
        access_token=user["token"],
    )


@team_router.get("/progress-updates", response_model=list[ProgressUpdateResponse])
async def get_progress_updates(user=Depends(require_roles("employee"))):
    return await backend_request(
        "GET",
        "/internal/progress-updates",
        access_token=user["token"],
    )


@team_router.patch("/team-members/{member_id}", response_model=TeamMemberResponse)
async def update_team_member(
    member_id: int,
    member: TeamMemberUpdate,
    user=Depends(require_roles("admin")),
):
    payload = member.model_dump(mode="json", exclude_unset=True)
    if not payload:
        raise HTTPException(status_code=400, detail="Provide at least one field to update.")
    return await backend_request(
        "PATCH",
        f"/internal/team-members/{member_id}",
        json=payload,
        access_token=user["token"],
    )


# ---------------------------------------------------------
# GET DASHBOARD
# ---------------------------------------------------------

dashboard_router = APIRouter(tags=["Dashboard"])


@dashboard_router.get(
    "/dashboard/summary",
    response_model=DashboardSummary,
)
async def get_dashboard_summary(user=Depends(require_roles("support", "admin"))):
    data = await backend_request(
        "GET",
        "/internal/dashboard",
        access_token=user["token"],
    )

    return data