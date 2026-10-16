from sqlalchemy import CheckConstraint, Column, Integer, String, DateTime, Boolean, ForeignKey, Text
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship, declarative_base

Base = declarative_base()


class TeamMember(Base):
    __tablename__ = "team_members"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    email = Column(String(255), nullable=False, unique=True)
    is_active = Column(Boolean, nullable=False, default=True)
    role = Column(String(20), nullable=False, default="support", server_default="support")
    password_hash = Column(String(255), nullable=True)
    # Cognito identity mapping (Phase 1). Nullable so existing users keep NULL
    # until linked to a Cognito identity; unique index allows multiple NULLs
    # while rejecting duplicate non-null subjects.
    cognito_sub = Column(String(255), nullable=True, unique=True, index=True)
    # Legacy invitation-recovery key retained for existing rows; public
    # registration maps identities through AccessRequest.cognito_sub instead.
    cognito_provisioning_id = Column(String(32), nullable=True, unique=True)
    # Optional E.164 contact number (profile UI + Cognito phone_number attribute).
    # Not an authorization input.
    phone_number = Column(String(32), nullable=True)
    # Display-only mirror of the user's Cognito TOTP MFA status. Cognito is the
    # source of truth; this is never trusted for an auth/authz decision.
    mfa_enabled = Column(Boolean, nullable=False, default=False, server_default="false")

    # Relationships
    assigned_requests = relationship("SupportRequest", back_populates="assignee")


class AccessRequest(Base):
    __tablename__ = "access_requests"
    __table_args__ = (
        CheckConstraint("role IN ('employee', 'support')", name="ck_access_requests_role"),
        CheckConstraint("status IN ('pending', 'approved', 'rejected')", name="ck_access_requests_status"),
    )

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    email = Column(String(255), nullable=False, index=True)
    # Set only after the registrant completes Cognito email verification and
    # presents a cryptographically validated access token.
    cognito_sub = Column(String(255), nullable=True, unique=True, index=True)
    role = Column(String(20), nullable=False)
    password_hash = Column(String(255), nullable=True)
    message = Column(Text, nullable=True)
    status = Column(String(20), nullable=False, default="pending", server_default="pending", index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
    reviewed_by = Column(Integer, ForeignKey("team_members.id"), nullable=True)
    review_note = Column(Text, nullable=True)


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("team_members.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    used_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class SupportRequest(Base):
    __tablename__ = "support_requests"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=False)
    requester_name = Column(String(100), nullable=False)
    requester_email = Column(String(255), nullable=False)
    category = Column(String(50), nullable=False)
    priority = Column(String(20), nullable=False)
    status = Column(String(20), nullable=False, default="Open")
    assigned_to = Column(Integer, ForeignKey("team_members.id"), nullable=True)
    due_date = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    assignee = relationship("TeamMember", back_populates="assigned_requests")
    history_events = relationship(
        "HistoryEvent", back_populates="request", cascade="all, delete-orphan"
    )
    notes = relationship(
        "TicketNote", back_populates="request", cascade="all, delete-orphan"
    )
    attachments = relationship("RequestAttachment", back_populates="request")


class HistoryEvent(Base):
    __tablename__ = "history_events"

    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(
        Integer, ForeignKey("support_requests.id", ondelete="CASCADE"), nullable=False
    )
    event_type = Column(String(50), nullable=False)
    description = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    request = relationship("SupportRequest", back_populates="history_events")


class TicketNote(Base):
    __tablename__ = "ticket_notes"

    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(
        Integer,
        ForeignKey("support_requests.id", ondelete="CASCADE"),
        nullable=False,
    )
    note = Column(Text, nullable=False)
    created_by = Column(String(100), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    is_public = Column(Boolean, nullable=False, default=False, server_default="false")

    request = relationship("SupportRequest", back_populates="notes")


class RequestAttachment(Base):
    __tablename__ = "request_attachments"

    id = Column(Integer, primary_key=True, index=True)
    request_id = Column(
        Integer,
        ForeignKey("support_requests.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    uploaded_by_id = Column(
        Integer,
        ForeignKey("team_members.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    original_filename = Column(String(255), nullable=False)
    object_key = Column(String(512), nullable=False, unique=True)
    content_type = Column(String(100), nullable=False)
    size_bytes = Column(Integer, nullable=False)
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    request = relationship("SupportRequest", back_populates="attachments")
    uploaded_by = relationship("TeamMember")
