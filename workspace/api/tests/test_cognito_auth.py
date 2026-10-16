"""Public-API-tier Cognito validation + AUTH_MODE tests (Phase 3a).

The api tier cryptographically validates the Cognito access token (fail-closed)
and then resolves the DB-authoritative identity from the internal backend via
/internal/auth/whoami. These tests inject a fake-JWKS verifier and stub the
backend call, so no AWS or backend service is required.
"""

import time
import re

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

import auth
import cognito
from app import app
from routers import requests as requests_router


client = TestClient(app)

REGION = "ap-south-1"
POOL_ID = "ap-south-1_Test123"
CLIENT_ID = "test-app-client-id"
ISSUER = f"https://cognito-idp.{REGION}.amazonaws.com/{POOL_ID}"
KID = "test-key-1"

_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _FakeSigningKey:
    def __init__(self, key):
        self.key = key


class _FakeJwkClient:
    def __init__(self, public_key):
        self._public_key = public_key

    def get_signing_key_from_jwt(self, token):
        header = jwt.get_unverified_header(token)
        if header.get("kid") != KID:
            raise jwt.PyJWKClientError("Unknown kid")
        return _FakeSigningKey(self._public_key)


def _make_verifier():
    return cognito.CognitoVerifier(
        region=REGION,
        user_pool_id=POOL_ID,
        app_client_id=CLIENT_ID,
        jwk_client=_FakeJwkClient(_PRIVATE_KEY.public_key()),
    )


def _token(*, sub="cognito-sub-abc", token_use="access", client_id=CLIENT_ID,
           issuer=ISSUER, exp_delta=3600, kid=KID, sign_key=None):
    now = int(time.time())
    return jwt.encode(
        {
            "sub": sub, "iss": issuer, "token_use": token_use,
            "client_id": client_id, "iat": now, "exp": now + exp_delta,
            "username": "someone",
        },
        sign_key or _PRIVATE_KEY,
        algorithm="RS256",
        headers={"kid": kid},
    )


@pytest.fixture(autouse=True)
def _cognito_mode(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "cognito")
    cognito.set_verifier(_make_verifier())
    yield
    cognito.reset_verifier()


class _FakeResponse:
    def __init__(self, status_code, data):
        self.status_code = status_code
        self._data = data

    def json(self):
        return self._data


def _stub_whoami(monkeypatch, status_code, data):
    """Stub the api tier's backend whoami call."""
    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            self.headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def get(self, path, headers=None):
            assert path == "/internal/auth/whoami"
            return _FakeResponse(status_code, data)

    monkeypatch.setattr(auth.httpx, "AsyncClient", _FakeAsyncClient)


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_valid_cognito_token_resolves_identity_and_authorizes(monkeypatch):
    # Backend says this identity is an admin -> admin route allowed.
    # A single fake client serves BOTH the whoami resolve (.get) and the
    # downstream proxy (.request), since both call sites use httpx.AsyncClient.
    whoami_body = {"id": 5, "email": "a@x.com", "name": "A", "role": "admin"}

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            self.headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def get(self, path, headers=None):
            return _FakeResponse(200, whoami_body)

        async def request(self, method, path, params=None, json=None, headers=None):
            return _FakeResponse(200, [])

    monkeypatch.setattr(auth.httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setattr(requests_router.httpx, "AsyncClient", _FakeAsyncClient)
    res = client.get("/access-requests", headers=_auth(_token()))
    assert res.status_code == 200


def test_invalid_signature_rejected_before_backend(monkeypatch):
    # If validation fails, the backend must never be called.
    called = {"n": 0}

    class _NoCall:
        def __init__(self, *a, **k):
            called["n"] += 1
            self.headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def get(self, *a, **k):
            raise AssertionError("backend must not be called for an invalid token")

    monkeypatch.setattr(auth.httpx, "AsyncClient", _NoCall)
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    res = client.get("/access-requests", headers=_auth(_token(sign_key=other)))
    assert res.status_code == 401
    assert called["n"] == 0


@pytest.mark.parametrize(
    "token_kwargs",
    [
        {"exp_delta": -10},
        {"issuer": "https://cognito-idp.us-east-1.amazonaws.com/other-pool"},
        {"token_use": "id"},
    ],
)
def test_invalid_cognito_claims_rejected_before_backend(monkeypatch, token_kwargs):
    called = {"n": 0}

    class _NoCall:
        def __init__(self, *args, **kwargs):
            called["n"] += 1
            self.headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, *args, **kwargs):
            raise AssertionError("backend must not be called for an invalid token")

    monkeypatch.setattr(auth.httpx, "AsyncClient", _NoCall)
    response = client.get("/auth/whoami", headers=_auth(_token(**token_kwargs)))
    assert response.status_code == 401
    assert called["n"] == 0


def test_wrong_client_rejected(monkeypatch):
    _stub_whoami(monkeypatch, 200, {"id": 1, "email": "x@x.com", "name": "X", "role": "admin"})
    res = client.get("/access-requests", headers=_auth(_token(client_id="other")))
    assert res.status_code == 401


def test_backend_401_remains_401(monkeypatch):
    _stub_whoami(monkeypatch, 401, {"detail": "Account is inactive or unavailable."})
    res = client.get("/access-requests", headers=_auth(_token()))
    assert res.status_code == 401


def test_employee_denied_admin_route(monkeypatch):
    _stub_whoami(monkeypatch, 200, {"id": 2, "email": "e@x.com", "name": "E", "role": "employee"})
    res = client.get("/access-requests", headers=_auth(_token()))
    assert res.status_code == 403


def test_missing_token_rejected():
    res = client.get("/access-requests")
    assert res.status_code == 401


def test_whoami_returns_db_identity_without_token(monkeypatch):
    # /auth/whoami resolves the DB-authoritative identity and never echoes the token.
    whoami_body = {"id": 7, "email": "w@x.com", "name": "W", "role": "support"}

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            self.headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def get(self, path, headers=None):
            return _FakeResponse(200, whoami_body)

    monkeypatch.setattr(auth.httpx, "AsyncClient", _FakeAsyncClient)
    res = client.get("/auth/whoami", headers=_auth(_token()))
    assert res.status_code == 200
    body = res.json()
    assert body == {"id": 7, "email": "w@x.com", "name": "W", "role": "support"}
    assert "token" not in body


def test_whoami_accepts_legacy_alias(monkeypatch):
    whoami_body = {"id": 7, "email": "w@x.com", "name": "W", "role": "support"}

    class _FakeAsyncClient:
        def __init__(self, *a, **k):
            self.headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def get(self, path, headers=None):
            return _FakeResponse(200, whoami_body)

    monkeypatch.setattr(auth.httpx, "AsyncClient", _FakeAsyncClient)
    res = client.get("/auth/whami", headers=_auth(_token()))
    assert res.status_code == 200
    assert res.json() == {"id": 7, "email": "w@x.com", "name": "W", "role": "support"}


def test_whoami_requires_auth():
    assert client.get("/auth/whoami").status_code == 401


def test_verified_phone_sync_forwards_authenticated_cognito_token(monkeypatch):
    token = _token()
    _stub_whoami(
        monkeypatch,
        200,
        {"id": 7, "email": "w@x.com", "name": "W", "role": "support"},
    )
    forwarded = {}

    async def fake_backend_request(method, path, *, access_token=None, **_kwargs):
        forwarded.update(method=method, path=path, access_token=access_token)
        return {"phone_number": "+919999999999", "phone_verified": True}

    monkeypatch.setattr(requests_router, "backend_request", fake_backend_request)
    response = client.post("/profile/phone", headers=_auth(token))

    assert response.status_code == 200
    assert response.json() == {"phone_number": "+919999999999", "phone_verified": True}
    assert forwarded == {
        "method": "POST",
        "path": "/internal/profile/phone",
        "access_token": token,
    }


def test_mfa_status_sync_forwards_authenticated_cognito_token(monkeypatch):
    token = _token()
    _stub_whoami(
        monkeypatch,
        200,
        {"id": 7, "email": "w@x.com", "name": "W", "role": "support"},
    )
    forwarded = {}

    async def fake_backend_request(method, path, *, access_token=None, **_kwargs):
        forwarded.update(method=method, path=path, access_token=access_token)
        return {"mfa_enabled": True}

    monkeypatch.setattr(requests_router, "backend_request", fake_backend_request)
    response = client.post("/profile/mfa", headers=_auth(token))

    assert response.status_code == 200
    assert response.json() == {"mfa_enabled": True}
    assert forwarded == {
        "method": "POST",
        "path": "/internal/profile/mfa",
        "access_token": token,
    }


@pytest.mark.parametrize(
    ("backend_status", "expected_status"),
    [(401, 401), (403, 403), (500, 502)],
)
def test_backend_identity_statuses_are_not_collapsed(
    monkeypatch, backend_status, expected_status
):
    _stub_whoami(monkeypatch, backend_status, {"detail": "not forwarded"})
    response = client.get("/auth/whoami", headers=_auth(_token()))
    assert response.status_code == expected_status


def test_backend_timeout_is_reported_as_gateway_timeout(monkeypatch):
    class _TimeoutClient:
        def __init__(self, *args, **kwargs):
            self.headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, path, headers=None):
            raise auth.httpx.ReadTimeout("timeout")

    monkeypatch.setattr(auth.httpx, "AsyncClient", _TimeoutClient)
    response = client.get("/auth/whoami", headers=_auth(_token()))
    assert response.status_code == 504


def test_same_bearer_token_and_request_id_are_forwarded(monkeypatch):
    received = {}
    access_token = _token()

    class _IdentityClient:
        def __init__(self, *args, **kwargs):
            self.headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, path, headers=None):
            received["path"] = path
            received["authorization"] = headers.get("Authorization")
            received["request_id"] = self.headers.get("X-Request-ID")
            return _FakeResponse(
                200, {"id": 7, "email": "w@x.com", "name": "W", "role": "admin"}
            )

    monkeypatch.setattr(auth.httpx, "AsyncClient", _IdentityClient)
    response = client.get("/auth/whoami", headers=_auth(access_token))
    assert response.status_code == 200
    assert received["path"] == "/internal/auth/whoami"
    assert received["authorization"] == f"Bearer {access_token}"
    assert re.fullmatch(r"[0-9a-f]{32}", received["request_id"])
    assert response.headers["x-request-id"] == received["request_id"]
    assert response.json()["role"] == "admin"
    assert "token" not in response.json()


def test_missing_cognito_configuration_is_not_reported_as_bad_token(monkeypatch):
    def missing_configuration():
        raise cognito.CognitoConfigurationError("missing config")

    monkeypatch.setattr(auth, "get_verifier", missing_configuration)
    response = client.get("/auth/whoami", headers=_auth(_token()))
    assert response.status_code == 500
    assert response.json()["detail"] == "Cognito authentication is not configured."


def test_jwks_outage_is_not_reported_as_bad_token(monkeypatch):
    class _UnavailableVerifier:
        def verify_access_token(self, token):
            raise cognito.CognitoVerificationUnavailable("JWKS unavailable")

    monkeypatch.setattr(auth, "get_verifier", lambda: _UnavailableVerifier())
    response = client.get("/auth/whoami", headers=_auth(_token()))
    assert response.status_code == 503


def test_invalid_backend_identity_schema_is_reported_as_bad_gateway(monkeypatch):
    _stub_whoami(monkeypatch, 200, {"id": "not-an-integer"})
    response = client.get("/auth/whoami", headers=_auth(_token()))
    assert response.status_code == 502
    assert response.json()["detail"] == "Authentication service returned an invalid identity."


def test_signup_forwards_access_token_for_backend_identity_verification(monkeypatch):
    received = {}
    token = _token()
    response_body = {
        "id": 7,
        "name": "New Support",
        "email": "support@example.com",
        "role": "support",
        "message": None,
        "status": "pending",
        "created_at": "2026-10-15T12:00:00Z",
        "reviewed_at": None,
        "reviewed_by": None,
        "review_note": None,
        "email_verified": True,
    }

    class _SignupClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def request(self, method, path, params=None, json=None, headers=None):
            received.update(method=method, path=path, json=json, headers=headers)
            return _FakeResponse(201, response_body)

    monkeypatch.setattr(auth.httpx, "AsyncClient", _SignupClient)
    response = client.post(
        "/auth/signup",
        headers=_auth(token),
        json={"role": "support"},
    )
    assert response.status_code == 201
    assert received == {
        "method": "POST",
        "path": "/internal/access-requests",
        "json": {"role": "support", "message": None},
        "headers": {"Authorization": f"Bearer {token}"},
    }
    assert response.json()["email_verified"] is True


def test_signup_requires_a_bearer_token():
    response = client.post("/auth/signup", json={"role": "employee"})
    assert response.status_code == 401


def test_team_member_creation_route_is_removed():
    response = client.post(
        "/team-members",
        headers=_auth(_token()),
        json={"name": "New Support", "email": "support@example.com", "role": "support"},
    )
    assert response.status_code == 405
