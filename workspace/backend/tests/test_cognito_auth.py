"""Security tests for Cognito access-token verification + AUTH_MODE (Phase 3a).

These tests mint RS256 tokens with a locally-generated RSA key and inject a fake
JWKS client into the verifier, so NO real AWS/Cognito resources are touched.
They assert fail-closed behaviour across the full validation matrix and verify
that application role/active status come from PostgreSQL, never the token.
"""

import time
from datetime import datetime, timezone

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.auth as auth
import app.cognito as cognito
import app.main as backend_main
from app.main import app
from database.app.database import get_db
from database.app.models import Base, TeamMember


REGION = "ap-south-1"
POOL_ID = "ap-south-1_Test123"
CLIENT_ID = "test-app-client-id"
ISSUER = f"https://cognito-idp.{REGION}.amazonaws.com/{POOL_ID}"
KID = "test-key-1"


# ---------------------------------------------------------------------------
# RSA key + fake JWKS plumbing
# ---------------------------------------------------------------------------
_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class _FakeSigningKey:
    def __init__(self, key):
        self.key = key


class _FakeJwkClient:
    """Stand-in for PyJWKClient that returns our locally-generated public key."""

    def __init__(self, public_key):
        self._public_key = public_key

    def get_signing_key_from_jwt(self, token):
        # Mimic PyJWKClient: raise if the token header lacks our kid.
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


def _token(
    *,
    sub="cognito-sub-abc",
    token_use="access",
    client_id=CLIENT_ID,
    issuer=ISSUER,
    exp_delta=3600,
    kid=KID,
    sign_key=None,
    extra=None,
):
    now = int(time.time())
    payload = {
        "sub": sub,
        "iss": issuer,
        "token_use": token_use,
        "client_id": client_id,
        "iat": now,
        "exp": now + exp_delta,
        "username": "someone",
    }
    if extra:
        payload.update(extra)
    return jwt.encode(
        payload,
        sign_key or _PRIVATE_KEY,
        algorithm="RS256",
        headers={"kid": kid},
    )


# ---------------------------------------------------------------------------
# DB + app fixtures (mirrors the existing test_auth_access.py pattern)
# ---------------------------------------------------------------------------
@pytest.fixture
def db():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    yield session
    session.close()
    engine.dispose()


@pytest.fixture
def client(db):
    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _inject_verifier(monkeypatch):
    """Inject the fake-JWKS verifier and ensure a clean AUTH_MODE per test."""
    monkeypatch.setenv("AUTH_MODE", "cognito")
    cognito.set_verifier(_make_verifier())
    yield
    cognito.reset_verifier()


def _add_member(db, *, cognito_sub=None, role="support", is_active=True, email="u@x.com"):
    member = TeamMember(
        name="User",
        email=email,
        role=role,
        is_active=is_active,
        cognito_sub=cognito_sub,
    )
    db.add(member)
    db.commit()
    db.refresh(member)
    return member


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# Verifier-level tests (unit)
# ---------------------------------------------------------------------------
def test_valid_access_token_passes():
    verifier = _make_verifier()
    claims = verifier.verify_access_token(_token())
    assert claims.sub == "cognito-sub-abc"
    assert claims.client_id == CLIENT_ID
    assert claims.token_use == "access"


def test_verified_phone_profile_sync_updates_only_the_mapped_member(monkeypatch, db, client):
    member = _add_member(db, cognito_sub="cognito-sub-abc")
    token = _token()

    class FakeCognito:
        def get_user(self, *, AccessToken):
            assert AccessToken == token
            return {
                "UserAttributes": [
                    {"Name": "sub", "Value": "cognito-sub-abc"},
                    {"Name": "phone_number", "Value": "+919999999999"},
                    {"Name": "phone_number_verified", "Value": "true"},
                ]
            }

    monkeypatch.setattr(
        backend_main.boto3,
        "client",
        lambda service, region_name=None: FakeCognito(),
    )
    response = client.post("/internal/profile/phone", headers=_auth(token))

    assert response.status_code == 200
    assert response.json() == {
        "phone_number": "+919999999999",
        "phone_verified": True,
    }
    db.refresh(member)
    assert member.phone_number == "+919999999999"


def test_unverified_cognito_phone_is_not_written_to_profile(monkeypatch, db, client):
    member = _add_member(db, cognito_sub="cognito-sub-abc")

    class FakeCognito:
        def get_user(self, **_kwargs):
            return {
                "UserAttributes": [
                    {"Name": "sub", "Value": "cognito-sub-abc"},
                    {"Name": "phone_number", "Value": "+919999999999"},
                    {"Name": "phone_number_verified", "Value": "false"},
                ]
            }

    monkeypatch.setattr(
        backend_main.boto3,
        "client",
        lambda service, region_name=None: FakeCognito(),
    )
    response = client.post("/internal/profile/phone", headers=_auth(_token()))

    assert response.status_code == 409
    db.refresh(member)
    assert member.phone_number is None


def test_phone_sync_rejects_cognito_subject_mismatch(monkeypatch, db, client):
    member = _add_member(db, cognito_sub="different-cognito-sub")

    class FakeCognito:
        def get_user(self, **_kwargs):
            return {
                "UserAttributes": [
                    {"Name": "sub", "Value": "cognito-sub-abc"},
                    {"Name": "phone_number", "Value": "+919999999999"},
                    {"Name": "phone_number_verified", "Value": "true"},
                ]
            }

    monkeypatch.setattr(
        backend_main.boto3,
        "client",
        lambda service, region_name=None: FakeCognito(),
    )
    response = client.post("/internal/profile/phone", headers=_auth(_token()))

    assert response.status_code == 403
    db.refresh(member)
    assert member.phone_number is None


@pytest.mark.parametrize(
    ("mfa_settings", "expected_enabled"),
    [
        (["SOFTWARE_TOKEN_MFA"], True),
        ([], False),
    ],
)
def test_profile_mfa_sync_uses_cognito_settings(
    monkeypatch, db, client, mfa_settings, expected_enabled
):
    member = _add_member(db, cognito_sub="cognito-sub-abc")
    token = _token()

    class FakeCognito:
        def get_user(self, *, AccessToken):
            assert AccessToken == token
            return {
                "UserAttributes": [{"Name": "sub", "Value": "cognito-sub-abc"}],
                "UserMFASettingList": mfa_settings,
            }

    monkeypatch.setattr(
        backend_main.boto3,
        "client",
        lambda service, region_name=None: FakeCognito(),
    )
    response = client.post("/internal/profile/mfa", headers=_auth(token))

    assert response.status_code == 200
    assert response.json() == {"mfa_enabled": expected_enabled}
    db.refresh(member)
    assert member.mfa_enabled is False


def test_profile_mfa_sync_rejects_cognito_subject_mismatch(monkeypatch, db, client):
    member = _add_member(db, cognito_sub="different-cognito-sub")

    class FakeCognito:
        def get_user(self, **_kwargs):
            return {
                "UserAttributes": [{"Name": "sub", "Value": "cognito-sub-abc"}],
                "UserMFASettingList": ["SOFTWARE_TOKEN_MFA"],
            }

    monkeypatch.setattr(
        backend_main.boto3,
        "client",
        lambda service, region_name=None: FakeCognito(),
    )
    response = client.post("/internal/profile/mfa", headers=_auth(_token()))

    assert response.status_code == 403
    db.refresh(member)
    assert member.mfa_enabled is False


def test_invalid_signature_rejected():
    # Sign with a DIFFERENT key than the JWKS exposes.
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    verifier = _make_verifier()
    with pytest.raises(cognito.CognitoTokenError):
        verifier.verify_access_token(_token(sign_key=other_key))


def test_wrong_issuer_rejected():
    verifier = _make_verifier()
    with pytest.raises(cognito.CognitoTokenError):
        verifier.verify_access_token(
            _token(issuer="https://cognito-idp.us-east-1.amazonaws.com/evil")
        )


def test_wrong_client_id_rejected():
    verifier = _make_verifier()
    with pytest.raises(cognito.CognitoTokenError):
        verifier.verify_access_token(_token(client_id="some-other-client"))


def test_expired_token_rejected():
    verifier = _make_verifier()
    with pytest.raises(cognito.CognitoTokenError):
        verifier.verify_access_token(_token(exp_delta=-10))


def test_wrong_token_use_rejected():
    # An ID token must not be accepted where an access token is required.
    verifier = _make_verifier()
    with pytest.raises(cognito.CognitoTokenError):
        verifier.verify_access_token(_token(token_use="id"))


def test_unknown_kid_rejected():
    verifier = _make_verifier()
    with pytest.raises(cognito.CognitoTokenError):
        verifier.verify_access_token(_token(kid="rotated-away"))


def test_jwks_connection_failure_is_reported_as_unavailable():
    class _UnavailableJwkClient:
        def get_signing_key_from_jwt(self, token):
            raise jwt.PyJWKClientConnectionError("connection failure")

    verifier = cognito.CognitoVerifier(
        region=REGION,
        user_pool_id=POOL_ID,
        app_client_id=CLIENT_ID,
        jwk_client=_UnavailableJwkClient(),
    )
    with pytest.raises(cognito.CognitoVerificationUnavailable):
        verifier.verify_access_token(_token())


def test_missing_sub_rejected():
    verifier = _make_verifier()
    # Build a token with no sub by signing a custom payload.
    now = int(time.time())
    token = jwt.encode(
        {"iss": ISSUER, "token_use": "access", "client_id": CLIENT_ID, "exp": now + 60},
        _PRIVATE_KEY,
        algorithm="RS256",
        headers={"kid": KID},
    )
    with pytest.raises(cognito.CognitoTokenError):
        verifier.verify_access_token(token)


# ---------------------------------------------------------------------------
# End-to-end (dependency) tests: cognito_sub -> DB mapping + RBAC
# ---------------------------------------------------------------------------
def test_cognito_login_maps_sub_to_db_and_uses_db_role(db, client):
    # Token carries NO role; DB says admin. The DB role must win.
    _add_member(db, cognito_sub="cognito-sub-abc", role="admin", email="admin@x.com")
    res = client.get("/internal/auth/whoami", headers=_auth(_token(sub="cognito-sub-abc")))
    assert res.status_code == 200
    body = res.json()
    assert body["role"] == "admin"
    assert body["email"] == "admin@x.com"


def test_whoami_includes_profile_fields(db, client):
    # Profile UI needs phone_number + mfa_enabled from the DB (authoritative).
    member = _add_member(db, cognito_sub="cognito-sub-abc", role="support", email="p@x.com")
    member.phone_number = "+911234567890"
    member.mfa_enabled = True
    db.commit()
    res = client.get("/internal/auth/whoami", headers=_auth(_token(sub="cognito-sub-abc")))
    assert res.status_code == 200
    body = res.json()
    assert body["phone_number"] == "+911234567890"
    assert body["mfa_enabled"] is True


def test_unknown_cognito_sub_is_rejected(db, client):
    _add_member(db, cognito_sub="different-sub")
    res = client.get("/internal/auth/whoami", headers=_auth(_token(sub="no-such-sub")))
    assert res.status_code == 403


def test_inactive_user_is_rejected(db, client):
    _add_member(db, cognito_sub="cognito-sub-abc", is_active=False)
    res = client.get("/internal/auth/whoami", headers=_auth(_token(sub="cognito-sub-abc")))
    assert res.status_code == 403


def test_missing_cognito_configuration_is_reported_as_server_error(
    db, client, monkeypatch
):
    def missing_configuration():
        raise cognito.CognitoConfigurationError("missing config")

    monkeypatch.setattr(auth, "get_verifier", missing_configuration)
    response = client.get(
        "/internal/auth/whoami",
        headers=_auth(_token(sub="cognito-sub-abc")),
    )
    assert response.status_code == 500


def test_jwks_outage_is_reported_as_service_unavailable(db, client, monkeypatch):
    class _UnavailableVerifier:
        def verify_access_token(self, token):
            raise cognito.CognitoVerificationUnavailable("JWKS unavailable")

    monkeypatch.setattr(auth, "get_verifier", lambda: _UnavailableVerifier())
    response = client.get(
        "/internal/auth/whoami",
        headers=_auth(_token(sub="cognito-sub-abc")),
    )
    assert response.status_code == 503


def test_role_from_token_is_ignored(db, client):
    # Attacker-supplied role=admin in the token must NOT grant admin.
    _add_member(db, cognito_sub="cognito-sub-abc", role="employee", email="emp@x.com")
    token = _token(sub="cognito-sub-abc", extra={"role": "admin", "cognito:groups": ["admin"]})
    res = client.get("/internal/auth/whoami", headers=_auth(token))
    assert res.status_code == 200
    assert res.json()["role"] == "employee"


def test_employee_rbac_denied_on_admin_route(db, client):
    _add_member(db, cognito_sub="cognito-sub-abc", role="employee")
    res = client.get("/internal/access-requests", headers=_auth(_token(sub="cognito-sub-abc")))
    assert res.status_code == 403


def test_admin_rbac_allowed_on_admin_route(db, client):
    _add_member(db, cognito_sub="cognito-sub-abc", role="admin")
    res = client.get("/internal/access-requests", headers=_auth(_token(sub="cognito-sub-abc")))
    assert res.status_code == 200


# ---------------------------------------------------------------------------
# AUTH_MODE gating
# ---------------------------------------------------------------------------
def test_cognito_mode_rejects_legacy_token(db, client, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "cognito")
    monkeypatch.setattr(auth, "JWT_SECRET", "legacy-secret-with-32-bytes-minimum")
    member = _add_member(db, cognito_sub="cognito-sub-abc", role="admin")
    legacy = auth.create_access_token(member)  # HS256
    res = client.get("/internal/auth/whoami", headers=_auth(legacy))
    assert res.status_code == 401


def test_dual_mode_accepts_both_and_never_downgrades(db, client, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "dual")
    monkeypatch.setattr(auth, "JWT_SECRET", "legacy-secret-with-32-bytes-minimum")
    member = _add_member(db, cognito_sub="cognito-sub-abc", role="support")

    # Legacy token works in dual mode.
    legacy = auth.create_access_token(member)
    assert client.get("/internal/auth/whoami", headers=_auth(legacy)).status_code == 200

    # Valid Cognito token works in dual mode.
    assert client.get(
        "/internal/auth/whoami", headers=_auth(_token(sub="cognito-sub-abc"))
    ).status_code == 200

    # A token that CLAIMS a Cognito issuer but fails validation (bad signature)
    # must be rejected, NOT downgraded to legacy.
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    forged = _token(sub="cognito-sub-abc", sign_key=other_key)
    assert client.get("/internal/auth/whoami", headers=_auth(forged)).status_code == 401


def test_legacy_mode_rejects_cognito_token(db, client, monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "legacy")
    monkeypatch.setattr(auth, "JWT_SECRET", "legacy-secret-with-32-bytes-minimum")
    _add_member(db, cognito_sub="cognito-sub-abc", role="admin")
    # A Cognito RS256 token is not a valid HS256 app token -> 401.
    res = client.get("/internal/auth/whoami", headers=_auth(_token(sub="cognito-sub-abc")))
    assert res.status_code == 401
