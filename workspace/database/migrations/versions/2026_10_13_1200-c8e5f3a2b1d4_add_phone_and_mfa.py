"""Add profile phone number and an MFA-status mirror to team members.

Phase (b1) of the Cognito + MFA migration. Both columns are additive and
nullable / defaulted, so existing rows and the current authentication flow are
unaffected.

  * ``phone_number`` — optional E.164 contact number shown in the profile UI
    and mapped to the Cognito ``phone_number`` standard attribute. It is NOT an
    authorization input.
  * ``mfa_enabled`` — a convenience MIRROR of whether the user has a confirmed
    TOTP factor in Cognito, used only for display in the profile/account UI.
    Cognito remains the source of truth for MFA; this flag is never trusted for
    an authentication or authorization decision.

Neither column changes roles, passwords, IDs, or any foreign key.

Revision ID: c8e5f3a2b1d4
Revises: b7d4e2f1a9c3
Create Date: 2026-10-13 12:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "c8e5f3a2b1d4"
down_revision = "b7d4e2f1a9c3"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "team_members",
        sa.Column("phone_number", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "team_members",
        sa.Column(
            "mfa_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade():
    op.drop_column("team_members", "mfa_enabled")
    op.drop_column("team_members", "phone_number")
