from fastapi.testclient import TestClient
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.auth as auth
import app.main as backend_main
from app.main import app
from database.app.database import get_db
from database.app.models import AccessRequest, Base, TeamMember


def test_verified_signup_identity_requires_matching_verified_cognito_profile(monkeypatch):
    class FakeVerifier:
        def verify_access_token(self, access_token):
            assert access_token == "verified-access-token"
            return type("Claims", (), {"sub": "verified-staff-sub"})()

    class FakeCognitoClient:
        def get_user(self, *, AccessToken):
            assert AccessToken == "verified-access-token"
            return {
                "UserAttributes": [
                    {"Name": "sub", "Value": "verified-staff-sub"},
                    {"Name": "email", "Value": "New-Staff@example.com"},
                    {"Name": "email_verified", "Value": "true"},
                    {"Name": "name", "Value": "New Staff"},
                ],
            }

    monkeypatch.setattr(backend_main, "get_verifier", lambda: FakeVerifier())
    monkeypatch.setattr(backend_main.boto3, "client", lambda *args, **kwargs: FakeCognitoClient())

    identity = backend_main.get_verified_signup_identity("verified-access-token")

    assert identity == {
        "sub": "verified-staff-sub",
        "email": "new-staff@example.com",
        "name": "New Staff",
    }


def test_unverified_or_mismatched_cognito_identity_cannot_request_access(monkeypatch):
    class FakeVerifier:
        def verify_access_token(self, _access_token):
            return type("Claims", (), {"sub": "verified-staff-sub"})()

    class FakeCognitoClient:
        def get_user(self, **_kwargs):
            return {
                "UserAttributes": [
                    {"Name": "sub", "Value": "different-sub"},
                    {"Name": "email", "Value": "new-staff@example.com"},
                    {"Name": "email_verified", "Value": "false"},
                    {"Name": "name", "Value": "New Staff"},
                ],
            }

    monkeypatch.setattr(backend_main, "get_verifier", lambda: FakeVerifier())
    monkeypatch.setattr(backend_main.boto3, "client", lambda *args, **kwargs: FakeCognitoClient())

    try:
        backend_main.get_verified_signup_identity("verified-access-token")
        raise AssertionError("unverified Cognito profile should be rejected")
    except HTTPException as error:
        assert error.status_code == 403


def test_signup_request_requires_admin_approval_before_login(monkeypatch):
    monkeypatch.setattr(auth, "JWT_SECRET", "access-request-test-secret-with-32-bytes")
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = session_factory()
    admin = TeamMember(
        name="Administrator",
        email="admin@example.com",
        role="admin",
        password_hash=auth.hash_password("AdminPass6"),
        is_active=True,
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)

    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    admin_headers = {"Authorization": f"Bearer {auth.create_access_token(admin)}"}
    def verified_identity(token):
        assert token == "verified-access-token"
        return {
            "sub": "verified-staff-sub",
            "email": "new-staff@example.com",
            "name": "New Staff",
        }

    monkeypatch.setattr(backend_main, "get_verified_signup_identity", verified_identity)
    try:
        payload = {
            "role": "employee",
            "message": "Requesting access",
        }
        assert client.post("/internal/access-requests", json=payload).status_code == 401
        submitted = client.post(
            "/internal/access-requests",
            headers={"Authorization": "Bearer verified-access-token"},
            json=payload,
        )
        assert submitted.status_code == 201
        assert submitted.json()["status"] == "pending"
        assert submitted.json()["email"] == "new-staff@example.com"
        assert submitted.json()["email_verified"] is True
        assert "password_hash" not in submitted.json()
        assert client.post(
            "/internal/auth/login",
            json={"email": "new-staff@example.com", "password": "Staff6x"},
        ).status_code == 401

        duplicate = client.post(
            "/internal/access-requests",
            headers={"Authorization": "Bearer verified-access-token"},
            json=payload,
        )
        assert duplicate.status_code == 201
        assert duplicate.json()["id"] == submitted.json()["id"]
        changed_role = client.post(
            "/internal/access-requests",
            headers={"Authorization": "Bearer verified-access-token"},
            json={**payload, "role": "support"},
        )
        assert changed_role.status_code == 409

        listing = client.get("/internal/access-requests", headers=admin_headers)
        assert listing.status_code == 200
        request_id = listing.json()[0]["id"]
        approved = client.patch(
            f"/internal/access-requests/{request_id}",
            headers=admin_headers,
            json={"status": "approved"},
        )
        assert approved.status_code == 200
        assert approved.json()["status"] == "approved"
        assert approved.json()["provisioning_status"] == "approved_and_linked"
        created_member = db.query(TeamMember).filter_by(email="new-staff@example.com").one()
        assert created_member.role == "employee"
        assert created_member.cognito_sub == "verified-staff-sub"
        assert created_member.is_active is True
        assert created_member.password_hash is None

        admin_signup = client.post(
            "/internal/access-requests",
            headers={"Authorization": "Bearer verified-access-token"},
            json={**payload, "role": "admin"},
        )
        assert admin_signup.status_code == 422
        assert db.query(AccessRequest).filter_by(id=request_id).one().password_hash is None

        unverified_request = AccessRequest(
            name="Unverified User",
            email="unverified@example.com",
            role="employee",
            status="pending",
        )
        db.add(unverified_request)
        db.commit()
        db.refresh(unverified_request)
        unverified_approval = client.patch(
            f"/internal/access-requests/{unverified_request.id}",
            headers=admin_headers,
            json={"status": "approved"},
        )
        assert unverified_approval.status_code == 409
        assert db.query(TeamMember).filter_by(email="unverified@example.com").first() is None
    finally:
        app.dependency_overrides.clear()
        db.close()
        engine.dispose()