"""CORS behavior for the public API, focused on the /auth/login flow.

These tests exercise Starlette's CORSMiddleware as configured in app.py:
  - the OPTIONS preflight for POST /auth/login is answered with the frontend
    origin echoed back and POST/OPTIONS + Authorization/Content-Type allowed;
  - a disallowed origin is NOT echoed;
  - CORS headers are present on error responses (so the browser sees the real
    status instead of an opaque CORS failure).
"""
from fastapi.testclient import TestClient

from app import app, ALLOWED_ORIGINS

client = TestClient(app)

FRONTEND_ORIGIN = "https://dlrs7mu8wley1.cloudfront.net"
CURRENT_FRONTEND_ORIGIN = "https://d1pmteawhkbk6r.cloudfront.net"


def test_production_frontend_origin_is_allowed():
    assert FRONTEND_ORIGIN in ALLOWED_ORIGINS
    assert CURRENT_FRONTEND_ORIGIN in ALLOWED_ORIGINS


def test_login_preflight_allows_frontend_origin():
    response = client.options(
        "/auth/login",
        headers={
            "Origin": FRONTEND_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,authorization",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == FRONTEND_ORIGIN
    assert response.headers["access-control-allow-credentials"] == "true"
    allow_methods = response.headers["access-control-allow-methods"]
    assert "POST" in allow_methods
    # The preflight echoes the requested headers; both must be permitted.
    allow_headers = response.headers["access-control-allow-headers"].lower()
    assert "authorization" in allow_headers
    assert "content-type" in allow_headers


def test_login_preflight_rejects_unknown_origin():
    response = client.options(
        "/auth/login",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    # Disallowed origin must not be echoed back.
    assert response.headers.get("access-control-allow-origin") != "https://evil.example.com"


def test_actual_login_post_carries_cors_headers_on_error(monkeypatch):
    # No backend is reachable in tests; the proxy call will fail, producing an
    # error response. The CORS header must still be present so the browser can
    # read the status rather than reporting a CORS block.
    response = client.post(
        "/auth/login",
        headers={"Origin": FRONTEND_ORIGIN, "Content-Type": "application/json"},
        json={"email": "someone@example.com", "password": "whatever"},
    )
    assert response.headers.get("access-control-allow-origin") == FRONTEND_ORIGIN
