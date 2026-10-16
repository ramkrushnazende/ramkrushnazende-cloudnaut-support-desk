"""Bind verified Cognito identities to pending access requests.

Revision ID: e4b7c2d9a610
Revises: d3a6f7b8c901
Create Date: 2026-10-15 14:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "e4b7c2d9a610"
down_revision = "d3a6f7b8c901"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "access_requests",
        sa.Column("cognito_sub", sa.String(length=255), nullable=True),
    )
    op.create_index(
        "ix_access_requests_cognito_sub",
        "access_requests",
        ["cognito_sub"],
        unique=True,
    )


def downgrade():
    op.drop_index("ix_access_requests_cognito_sub", table_name="access_requests")
    op.drop_column("access_requests", "cognito_sub")
