"""Unit tests for the idempotent Cognito bulk-migration tool (Phase b2).

A FAKE CognitoAdminClient is injected, so NO boto3/AWS call is ever made. The
tests assert dry-run safety, idempotency, the exists-relink path, skip reasons,
the email_verified decision rule, per-user failure isolation, and that no
business data (id/role/is_active) is ever mutated.
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.cognito_migration import (
    STATUS_ALREADY_LINKED,
    STATUS_CREATED,
    STATUS_FAILED,
    STATUS_LINKED_EXISTING,
    STATUS_SKIPPED,
    STATUS_WOULD_CREATE,
    CognitoAdminClient,
    UsernameExistsError,
    migrate_users,
)
from database.app.models import Base, TeamMember


class FakeCognito(CognitoAdminClient):
    """In-memory stand-in for CognitoAdminClient (no boto3)."""

    def __init__(self, *, existing=None, fail_emails=None):
        self.created = {}                      # email -> sub
        self.existing = dict(existing or {})   # email -> sub (pre-existing in pool)
        self.fail_emails = set(fail_emails or [])
        self.create_calls = []
        self.get_calls = []

    def create_user_with_invite(self, email, attributes):
        self.create_calls.append((email, attributes))
        if email in self.fail_emails:
            raise RuntimeError("Cognito create failed")
        if email in self.existing:
            raise UsernameExistsError(email)
        sub = f"sub-{email}"
        self.created[email] = sub
        return sub

    def get_user_sub(self, email):
        self.get_calls.append(email)
        return self.existing[email]


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


def _member(db, **kw):
    defaults = dict(name="U", is_active=True, role="support", password_hash="h")
    defaults.update(kw)
    m = TeamMember(**defaults)
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def _by_id(report, member_id):
    return next(r for r in report.results if r.member_id == member_id)


# ---------------------------------------------------------------------------
# Dry-run (default)
# ---------------------------------------------------------------------------
def test_dry_run_makes_no_changes(db):
    m = _member(db, email="a@x.com")
    fake = FakeCognito()
    report = migrate_users(db, fake, apply=False)

    assert report.dry_run is True
    assert _by_id(report, m.id).status == STATUS_WOULD_CREATE
    # No Cognito calls, no DB mutation.
    assert fake.create_calls == []
    db.refresh(m)
    assert m.cognito_sub is None


# ---------------------------------------------------------------------------
# Apply: create + link
# ---------------------------------------------------------------------------
def test_apply_creates_and_links_sub(db):
    m = _member(db, email="a@x.com")
    fake = FakeCognito()
    report = migrate_users(db, fake, apply=True)

    res = _by_id(report, m.id)
    assert res.status == STATUS_CREATED
    assert res.cognito_sub == "sub-a@x.com"
    db.refresh(m)
    assert m.cognito_sub == "sub-a@x.com"
    # id/role/is_active untouched.
    assert m.role == "support" and m.is_active is True


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------
def test_already_linked_is_skipped(db):
    m = _member(db, email="a@x.com", cognito_sub="pre-existing-sub")
    fake = FakeCognito()
    report = migrate_users(db, fake, apply=True)

    assert _by_id(report, m.id).status == STATUS_ALREADY_LINKED
    assert fake.create_calls == []  # never touched Cognito
    db.refresh(m)
    assert m.cognito_sub == "pre-existing-sub"  # not overwritten


def test_existing_cognito_user_is_relinked_not_duplicated(db):
    m = _member(db, email="dup@x.com")
    fake = FakeCognito(existing={"dup@x.com": "existing-sub-123"})
    report = migrate_users(db, fake, apply=True)

    res = _by_id(report, m.id)
    assert res.status == STATUS_LINKED_EXISTING
    assert res.cognito_sub == "existing-sub-123"
    assert fake.get_calls == ["dup@x.com"]
    db.refresh(m)
    assert m.cognito_sub == "existing-sub-123"


def test_rerun_after_first_apply_is_noop(db):
    m = _member(db, email="a@x.com")
    migrate_users(db, FakeCognito(), apply=True)
    db.refresh(m)
    first = m.cognito_sub
    # Second run: now already linked.
    fake2 = FakeCognito()
    report = migrate_users(db, fake2, apply=True)
    assert _by_id(report, m.id).status == STATUS_ALREADY_LINKED
    assert fake2.create_calls == []
    db.refresh(m)
    assert m.cognito_sub == first


# ---------------------------------------------------------------------------
# Skip reasons
# ---------------------------------------------------------------------------
def test_inactive_user_skipped(db):
    m = _member(db, email="a@x.com", is_active=False)
    report = migrate_users(db, FakeCognito(), apply=True)
    res = _by_id(report, m.id)
    assert res.status == STATUS_SKIPPED and "inactive" in res.reason


def test_user_without_password_hash_skipped(db):
    m = _member(db, email="seed@x.com", password_hash=None)
    report = migrate_users(db, FakeCognito(), apply=True)
    res = _by_id(report, m.id)
    assert res.status == STATUS_SKIPPED and "password_hash" in res.reason


# ---------------------------------------------------------------------------
# email_verified decision rule
# ---------------------------------------------------------------------------
def test_email_verified_is_false_even_for_active_with_password(db):
    # Policy: password hashes do NOT prove email ownership, so migrated users
    # are never pre-verified; they confirm email via the invitation flow.
    m = _member(db, email="v@x.com", is_active=True, password_hash="h")
    report = migrate_users(db, FakeCognito(), apply=True)
    assert _by_id(report, m.id).email_verified is False


def test_email_verified_reflected_in_cognito_attributes(db):
    m = _member(db, email="v@x.com")
    fake = FakeCognito()
    migrate_users(db, fake, apply=True)
    _, attrs = fake.create_calls[0]
    attr_map = {a["Name"]: a["Value"] for a in attrs}
    assert attr_map["email_verified"] == "false"
    assert attr_map["email"] == "v@x.com"


def test_phone_number_included_and_marked_unverified(db):
    m = _member(db, email="p@x.com", phone_number="+911234567890")
    fake = FakeCognito()
    migrate_users(db, fake, apply=True)
    _, attrs = fake.create_calls[0]
    attr_map = {a["Name"]: a["Value"] for a in attrs}
    assert attr_map["phone_number"] == "+911234567890"
    assert attr_map["phone_number_verified"] == "false"


# ---------------------------------------------------------------------------
# Per-user failure isolation
# ---------------------------------------------------------------------------
def test_one_failure_does_not_abort_others(db):
    good = _member(db, email="good@x.com")
    bad = _member(db, email="bad@x.com")
    other = _member(db, email="other@x.com")
    fake = FakeCognito(fail_emails={"bad@x.com"})

    report = migrate_users(db, fake, apply=True)

    assert _by_id(report, good.id).status == STATUS_CREATED
    assert _by_id(report, bad.id).status == STATUS_FAILED
    assert _by_id(report, other.id).status == STATUS_CREATED
    # The failed row is left unlinked; the others are linked.
    db.refresh(bad)
    assert bad.cognito_sub is None
    db.refresh(good)
    assert good.cognito_sub == "sub-good@x.com"


def test_report_summary_counts(db):
    _member(db, email="a@x.com")
    _member(db, email="b@x.com", is_active=False)
    report = migrate_users(db, FakeCognito(), apply=True)
    summary = report.summary()
    assert summary.get(STATUS_CREATED) == 1
    assert summary.get(STATUS_SKIPPED) == 1
