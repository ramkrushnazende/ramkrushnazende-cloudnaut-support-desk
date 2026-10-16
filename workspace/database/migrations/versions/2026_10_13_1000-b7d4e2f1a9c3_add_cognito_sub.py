"""Add Cognito subject identifier to team members.

Phase 1 of the Amazon Cognito migration: introduces a nullable mapping column
so each future Cognito user can be linked to an existing ``team_members`` row
WITHOUT re-keying ``team_members.id`` or touching any existing relationship.

The column is nullable so every existing user retains ``NULL`` until they are
linked to a Cognito identity in a later phase. A UNIQUE INDEX (not a plain
constraint) enforces that any two NON-NULL ``cognito_sub`` values differ while
still permitting multiple NULLs (true on both PostgreSQL and SQLite).

This migration does NOT alter authentication, roles, emails, password hashes,
or any foreign key.

Revision ID: b7d4e2f1a9c3
Revises: f31b2b6d9c42
Create Date: 2026-10-13 10:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "b7d4e2f1a9c3"
down_revision = "f31b2b6d9c42"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "team_members",
        sa.Column("cognito_sub", sa.String(length=255), nullable=True),
    )
    # Unique INDEX (not a UNIQUE constraint): on both PostgreSQL and SQLite this
    # rejects duplicate non-null values yet allows many rows to keep NULL, so
    # existing users remain valid until they are linked to a Cognito identity.
    op.create_index(
        "ix_team_members_cognito_sub",
        "team_members",
        ["cognito_sub"],
        unique=True,
    )


def downgrade():
    op.drop_index("ix_team_members_cognito_sub", table_name="team_members")
    op.drop_column("team_members", "cognito_sub")
