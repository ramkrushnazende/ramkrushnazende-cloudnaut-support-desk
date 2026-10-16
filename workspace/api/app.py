import os
import uuid

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers.requests import (
    router as requests_router,
    team_router,
    dashboard_router,
)
from routers.attachments import router as attachments_router


app = FastAPI(
    title="Cloudnaut Support Desk API",
    description="API for creating and managing support tickets",
    version="1.0.0",
)


@app.middleware("http")
async def attach_request_id(request, call_next):
    request_id = uuid.uuid4().hex
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response


# ---------------------------------------------------------
# CORS
# ---------------------------------------------------------
# The public API is called cross-origin by the deployed frontend (CloudFront)
# and by local Vite during development. API Gateway intentionally does NOT set
# CORS (see infra/lib/api-stack.ts) — CORS is owned here so headers are not
# duplicated. Starlette's CORSMiddleware wraps the whole app, so it also:
#   - answers the OPTIONS preflight automatically, and
#   - adds Access-Control-* headers to error responses (4xx/5xx), e.g. a 401
#     from a bad login, so the browser surfaces the real status instead of a
#     generic CORS failure.
#
# Allowed origins are explicit (never "*") because allow_credentials=True
# forbids a wildcard origin. The production frontend origin can be overridden /
# extended via FRONTEND_ORIGINS (comma-separated) without a code change.
_DEFAULT_ALLOWED_ORIGINS = [
    "https://dlrs7mu8wley1.cloudfront.net",  # previous frontend
    "https://d1a5d0plkslw74.cloudfront.net",  # current frontend
    "https://d26e7v7avs1w1m.cloudfront.net",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5174",
]


def _allowed_origins() -> list[str]:
    configured = os.getenv("FRONTEND_ORIGINS", "")
    extra = [origin.strip() for origin in configured.split(",") if origin.strip()]
    # De-duplicate while preserving order; env-provided origins take precedence
    # but the defaults remain so local dev keeps working.
    seen: dict[str, None] = {}
    for origin in extra + _DEFAULT_ALLOWED_ORIGINS:
        seen.setdefault(origin, None)
    return list(seen)


ALLOWED_ORIGINS = _allowed_origins()


app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    # Explicit methods/headers (not "*") so the preflight contract is clear and
    # correct alongside allow_credentials=True. OPTIONS is handled by the
    # middleware itself; the rest cover the API's actual verbs.
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Request-ID"],
)


# ---------------------------------------------------------
# HEALTH CHECK
# ---------------------------------------------------------

@app.get("/health", tags=["Health"])
def health_check():
    return {
        "status": "ok",
        "service": "cloudnaut-support-desk-api",
    }


# ---------------------------------------------------------
# API ROUTERS
# ---------------------------------------------------------

app.include_router(requests_router)
app.include_router(attachments_router)
app.include_router(team_router)
app.include_router(dashboard_router)