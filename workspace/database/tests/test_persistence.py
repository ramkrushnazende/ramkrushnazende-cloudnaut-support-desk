import pytest
from database.app.models import TeamMember, SupportRequest, HistoryEvent, TicketNote


def test_create_team_member(db_session):
    """Test creating and querying a team member."""
    member = TeamMember(name="Anita Desai", email="anita@cloudnaut.com", is_active=True)
    db_session.add(member)
    db_session.commit()

    saved = db_session.query(TeamMember).filter_by(email="anita@cloudnaut.com").first()
    assert saved is not None
    assert saved.name == "Anita Desai"
    assert saved.is_active is True


def test_create_support_request_default_status(db_session):
    """Test default values on new support request."""
    req = SupportRequest(
        title="Software License Required",
        description="Need license for Docker Desktop",
        requester_name="Yogesh ",
        requester_email="yogicloudnaut.com",
        category="Access",
        priority="Medium",
    )
    db_session.add(req)
    db_session.commit()

    saved = db_session.query(SupportRequest).filter_by(title="Software License Required").first()
    assert saved is not None
    assert saved.status == "Open"
    assert saved.assigned_to is None


def test_request_assignment_relationship(db_session):
    """Test assigning a support request to a team member."""
    member = TeamMember(name="Vikram Seth", email="vikram@cloudnaut.com", is_active=True)
    db_session.add(member)
    db_session.commit()

    req = SupportRequest(
        title="Database Slowdown",
        description="Queries taking > 5 seconds",
        requester_name="DevOps Team",
        requester_email="devops@cloudnaut.com",
        category="Data",
        priority="High",
        assigned_to=member.id,
    )
    db_session.add(req)
    db_session.commit()

    saved_req = db_session.query(SupportRequest).filter_by(title="Database Slowdown").first()
    assert saved_req.assignee is not None
    assert saved_req.assignee.name == "Vikram Seth"


def create_ticket_for_note_test(db_session):
    request = SupportRequest(
        title="VPN Issue",
        description="Unable to access the internal network",
        requester_name="Alex",
        requester_email="alex@example.com",
        category="Access",
        priority="High",
    )
    db_session.add(request)
    db_session.commit()
    return request


def test_create_ticket_note(db_session):
    request = create_ticket_for_note_test(db_session)
    note = TicketNote(
        request_id=request.id,
        note="Checked VPN configuration and started investigation",
        created_by="Rahul Verma",
    )
    db_session.add(note)
    db_session.commit()

    saved = db_session.query(TicketNote).filter_by(request_id=request.id).one()
    assert saved.note == "Checked VPN configuration and started investigation"
    assert saved.created_by == "Rahul Verma"


def test_ticket_note_relationship(db_session):
    request = create_ticket_for_note_test(db_session)
    request.notes.append(TicketNote(note="Initial investigation", created_by="Rahul Verma"))
    db_session.commit()

    saved_request = db_session.query(SupportRequest).filter_by(id=request.id).one()
    assert len(saved_request.notes) == 1
    assert saved_request.notes[0].note == "Initial investigation"


def test_ticket_note_cascade_delete(db_session):
    request = create_ticket_for_note_test(db_session)
    request.notes.append(TicketNote(note="Initial investigation"))
    db_session.commit()
    request_id = request.id

    db_session.delete(request)
    db_session.commit()

    assert db_session.query(TicketNote).filter_by(request_id=request_id).count() == 0


# ---------------------------------------------------------------------------
# Cognito identity mapping (Phase 1): cognito_sub column on team_members.
# These verify the new field without touching existing auth behaviour.
# ---------------------------------------------------------------------------
from sqlalchemy.exc import IntegrityError


def test_cognito_sub_defaults_to_null(db_session):
    """Existing-style users (no Cognito link) persist with cognito_sub NULL."""
    member = TeamMember(name="Nina Rao", email="nina@cloudnaut.com", is_active=True)
    db_session.add(member)
    db_session.commit()

    saved = db_session.query(TeamMember).filter_by(email="nina@cloudnaut.com").one()
    assert saved.cognito_sub is None


def test_multiple_members_may_have_null_cognito_sub(db_session):
    """The unique index must still allow many rows to keep NULL."""
    db_session.add_all([
        TeamMember(name="User One", email="one@cloudnaut.com", is_active=True),
        TeamMember(name="User Two", email="two@cloudnaut.com", is_active=True),
    ])
    db_session.commit()

    null_subs = (
        db_session.query(TeamMember)
        .filter(TeamMember.cognito_sub.is_(None))
        .count()
    )
    assert null_subs == 2


def test_cognito_sub_can_be_set_and_queried(db_session):
    """A member can be linked to a Cognito subject and looked up by it."""
    member = TeamMember(
        name="Linked User",
        email="linked@cloudnaut.com",
        is_active=True,
        cognito_sub="11111111-2222-3333-4444-555555555555",
    )
    db_session.add(member)
    db_session.commit()

    found = (
        db_session.query(TeamMember)
        .filter_by(cognito_sub="11111111-2222-3333-4444-555555555555")
        .one()
    )
    assert found.email == "linked@cloudnaut.com"


def test_duplicate_non_null_cognito_sub_is_rejected(db_session):
    """Two members cannot share the same non-null cognito_sub."""
    shared_sub = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    db_session.add(
        TeamMember(name="First", email="first@cloudnaut.com", is_active=True, cognito_sub=shared_sub)
    )
    db_session.commit()

    db_session.add(
        TeamMember(name="Second", email="second@cloudnaut.com", is_active=True, cognito_sub=shared_sub)
    )
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()


def test_existing_team_member_fields_unchanged(db_session):
    """Backward compatibility: existing columns behave exactly as before."""
    member = TeamMember(
        name="Role Check",
        email="rolecheck@cloudnaut.com",
        is_active=True,
        password_hash="not-a-real-hash",
    )
    db_session.add(member)
    db_session.commit()

    saved = db_session.query(TeamMember).filter_by(email="rolecheck@cloudnaut.com").one()
    assert saved.role == "support"  # unchanged server-side default
    assert saved.is_active is True
    assert saved.password_hash == "not-a-real-hash"
    assert saved.cognito_sub is None


# ---------------------------------------------------------------------------
# Profile phone + MFA mirror (Phase b1): phone_number + mfa_enabled columns.
# Additive and defaulted; existing behaviour must be unaffected.
# ---------------------------------------------------------------------------


def test_phone_and_mfa_default_values(db_session):
    """New members default to no phone and mfa_enabled False."""
    member = TeamMember(name="Phone User", email="phone@cloudnaut.com", is_active=True)
    db_session.add(member)
    db_session.commit()

    saved = db_session.query(TeamMember).filter_by(email="phone@cloudnaut.com").one()
    assert saved.phone_number is None
    assert saved.mfa_enabled is False


def test_phone_and_mfa_can_be_set(db_session):
    member = TeamMember(
        name="MFA User",
        email="mfa@cloudnaut.com",
        is_active=True,
        phone_number="+911234567890",
        mfa_enabled=True,
    )
    db_session.add(member)
    db_session.commit()

    saved = db_session.query(TeamMember).filter_by(email="mfa@cloudnaut.com").one()
    assert saved.phone_number == "+911234567890"
    assert saved.mfa_enabled is True


def test_existing_columns_unaffected_by_phone_mfa(db_session):
    """Backward compatibility: role/is_active/cognito_sub behave as before."""
    member = TeamMember(
        name="Compat",
        email="compat2@cloudnaut.com",
        is_active=True,
        password_hash="not-a-real-hash",
    )
    db_session.add(member)
    db_session.commit()

    saved = db_session.query(TeamMember).filter_by(email="compat2@cloudnaut.com").one()
    assert saved.role == "support"
    assert saved.cognito_sub is None
    assert saved.phone_number is None
    assert saved.mfa_enabled is False
