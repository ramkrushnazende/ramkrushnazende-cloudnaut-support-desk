"""Add singleton runtime security settings for admin MFA enforcement.

Revision ID: f5c8d1e2a304
Revises: e4b7c2d9a610
Create Date: 2026-10-19 16:00:00
"""

from alembic import op
import sqlalchemy as sa


revision = "f5c8d1e2a304"
down_revision = "e4b7c2d9a610"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "security_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column(
            "require_staff_mfa",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("updated_by", sa.Integer(), nullable=True),
        sa.CheckConstraint("id = 1", name="ck_security_settings_singleton"),
        sa.ForeignKeyConstraint(["updated_by"], ["team_members.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.bulk_insert(
        sa.table(
            "security_settings",
            sa.column("id", sa.Integer()),
            sa.column("require_staff_mfa", sa.Boolean()),
        ),
        [{"id": 1, "require_staff_mfa": False}],
    )


def downgrade():
    op.drop_table("security_settings")
