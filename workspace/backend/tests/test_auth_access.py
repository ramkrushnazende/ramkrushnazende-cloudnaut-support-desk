from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.auth as auth
import app.main as backend_main
from app.main import app
from database.app.database import get_db
from database.app.models import Base, PasswordResetToken, SupportRequest, TeamMember


def test_employee_access_is_limited_to_own_tickets_and_read_only(monkeypatch):
    monkeypatch.setattr(auth, "JWT_SECRET", "auth-access-test-secret-with-32-bytes")
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = session_factory()
    employee = TeamMember(
        name="Employee",
        email="employee@example.com",
        role="employee",
        is_active=True,
    )
    other_employee = TeamMember(
        name="Other Employee",
        email="other@example.com",
        role="employee",
        is_active=True,
    )
    technician = TeamMember(
        name="Support Technician",
        email="support@example.com",
        role="support",
        is_active=True,
    )
    db.add_all([employee, other_employee, technician])
    db.flush()
    db.add_all([
        SupportRequest(
            title="Mine",
            description="My issue",
            requester_name="Employee",
            requester_email="employee@example.com",
            category="Access",
            priority="Low",
            status="Open",
            assigned_to=technician.id,
        ),
        SupportRequest(
            title="Not mine",
            description="Another issue",
            requester_name="Other Employee",
            requester_email="other@example.com",
            category="Access",
            priority="Low",
            status="Open",
        ),
    ])
    db.commit()
    token = auth.create_access_token(employee)

    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    headers = {"Authorization": f"Bearer {token}"}
    try:
        listed = client.get("/internal/requests", headers=headers)
        assert listed.status_code == 200
        assert [ticket["title"] for ticket in listed.json()] == ["Mine"]
        assert listed.json()[0]["assigned_to_name"] == "Support Technician"

        forbidden_assignment = client.patch(
            "/internal/requests/1/assignment",
            headers=headers,
            json={"assigned_to": None},
        )
        assert forbidden_assignment.status_code == 403

        hidden_ticket = client.get("/internal/requests/2", headers=headers)
        assert hidden_ticket.status_code == 404

        anonymous = client.get("/internal/requests")
        assert anonymous.status_code == 401
    finally:
        app.dependency_overrides.clear()
        db.close()
        engine.dispose()


def test_admin_login_and_self_disable_protection(monkeypatch):
    monkeypatch.setattr(auth, "JWT_SECRET", "auth-access-test-secret-with-32-bytes")
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
        password_hash=auth.hash_password("AdminPassword-2026!"),
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
    try:
        login = client.post(
            "/internal/auth/login",
            json={"email": "ADMIN@example.com", "password": "AdminPassword-2026!"},
        )
        assert login.status_code == 200
        assert "password_hash" not in login.json()["user"]
        headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

        self_disable = client.patch(
            f"/internal/team-members/{admin.id}",
            headers=headers,
            json={"is_active": False},
        )
        assert self_disable.status_code == 400
    finally:
        app.dependency_overrides.clear()
        db.close()
        engine.dispose()


def test_password_reset_token_is_hashed_expires_and_is_single_use(monkeypatch):
    monkeypatch.setattr(auth, "JWT_SECRET", "password-reset-test-secret-with-32-bytes")
    monkeypatch.setenv("SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("SMTP_FROM_EMAIL", "support@example.test")
    sent = {}
    monkeypatch.setattr(
        backend_main,
        "send_password_reset_email",
        lambda email, name, token: sent.update(email=email, token=token),
    )
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = session_factory()
    member = TeamMember(
        name="Reset User",
        email="reset@example.com",
        role="support",
        password_hash=auth.hash_password("OldPassword-2026!"),
        is_active=True,
    )
    db.add(member)
    db.commit()

    def override_get_db():
        try:
            yield db
        finally:
            pass

    app.dependency_overrides[get_db] = override_get_db
    client = TestClient(app)
    try:
        requested = client.post(
            "/internal/auth/forgot-password",
            json={"email": "RESET@example.com"},
        )
        assert requested.status_code == 200
        assert "sent" in requested.json()["message"]
        assert sent["email"] == "reset@example.com"

        token_record = db.query(PasswordResetToken).one()
        assert token_record.token_hash != sent["token"]

        short_password = client.post(
            "/internal/auth/reset-password",
            json={"token": sent["token"], "password": "abcde"},
        )
        assert short_password.status_code == 400

        reset = client.post(
            "/internal/auth/reset-password",
            json={"token": sent["token"], "password": "NewPassword-2026!"},
        )
        assert reset.status_code == 200
        assert client.post(
            "/internal/auth/reset-password",
            json={"token": sent["token"], "password": "AnotherPassword-2026!"},
        ).status_code == 400
        assert client.post(
            "/internal/auth/login",
            json={"email": "reset@example.com", "password": "NewPassword-2026!"},
        ).status_code == 200
    finally:
        app.dependency_overrides.clear()
        db.close()
        engine.dispose()
