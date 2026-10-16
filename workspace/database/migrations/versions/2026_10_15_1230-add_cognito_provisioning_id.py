"""Add a durable Cognito provisioning recovery key.

Revision ID: d3a6f7b8c901
Revises: c8e5f3a2b1d4
Create Date: 2026-10-15 12:30:00
"""

from alembic import op
import sqlalchemy as sa


revision = "d3a6f7b8c901"
down_revision = "c8e5f3a2b1d4"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "team_members",
        sa.Column("cognito_provisioning_id", sa.String(length=32), nullable=True),
    )
    op.create_index(
        "ix_team_members_cognito_provisioning_id",
        "team_members",
        ["cognito_provisioning_id"],
        unique=True,
    )


def downgrade():
    op.drop_index(
        "ix_team_members_cognito_provisioning_id",
        table_name="team_members",
    )
    op.drop_column("team_members", "cognito_provisioning_id")
