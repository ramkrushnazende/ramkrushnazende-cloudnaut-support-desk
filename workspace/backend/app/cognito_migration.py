"""One-time, idempotent bulk migration of existing team_members into Cognito.

Phase (b2) of the Cognito migration. This tool provisions a Cognito user for
each eligible ``team_members`` row and links the returned Cognito ``sub`` back
into ``team_members.cognito_sub``. It is:

  * DRY-RUN BY DEFAULT — it plans and reports but makes NO changes unless
    ``--apply`` (CLI) / ``apply=True`` (function) is passed.
  * IDEMPOTENT — re-running after a partial failure is safe: already-linked
    rows are skipped, and a Cognito user that already exists is re-linked
    (never duplicated).
  * NON-DESTRUCTIVE — it never changes ``id``, ``role``, ``is_active``,
    passwords, tickets, or any other business data. It only ever fills a NULL
    ``cognito_sub``.

Security / safety:
  * Never copies or exports password hashes, and never sets a Cognito password.
    Users receive a temporary-password INVITATION email and set their own
    password (and enrol TOTP) on first login.
  * ``email_verified=true`` is set ONLY when the legacy account's email can be
    reliably treated as verified (active row WITH a usable password_hash — i.e.
    a real account that has authenticated through the existing system). All
    other rows are created with ``email_verified=false`` and must verify.
  * ``phone_number_verified`` is always false (never confirmed by the legacy
    system).
  * The Cognito client is INJECTED so unit tests use a fake and no real AWS
    call is ever made here.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass, field

from database.app.database import SessionLocal
from database.app.models import TeamMember


# Result statuses for the per-user report.
STATUS_CREATED = "created"            # new Cognito user created + linked
STATUS_LINKED_EXISTING = "linked_existing"  # Cognito user already existed; linked
STATUS_ALREADY_LINKED = "already_linked"    # cognito_sub already set; no-op
STATUS_SKIPPED = "skipped"            # not eligible (inactive / no email / no pwd)
STATUS_FAILED = "failed"              # an error occurred for this row
STATUS_WOULD_CREATE = "would_create"  # dry-run: would create+link
STATUS_WOULD_LINK_EXISTING = "would_link_existing"  # dry-run: would link existing


@dataclass
class UserResult:
    member_id: int
    email: str
    status: str
    reason: str = ""
    cognito_sub: str | None = None
    email_verified: bool | None = None


@dataclass
class MigrationReport:
    dry_run: bool
    results: list[UserResult] = field(default_factory=list)

    def add(self, result: UserResult) -> None:
        self.results.append(result)

    def summary(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for r in self.results:
            counts[r.status] = counts.get(r.status, 0) + 1
        return counts

    def to_json(self) -> str:
        return json.dumps(
            {
                "dry_run": self.dry_run,
                "summary": self.summary(),
                "results": [asdict(r) for r in self.results],
            },
            indent=2,
            sort_keys=True,
        )


class UsernameExistsError(Exception):
    """Raised by the Cognito client wrapper when the user already exists."""


def _email_is_reliably_verified(member: TeamMember) -> bool:
    """Never assert email_verified=true during bulk migration.

    A password hash proves the user set a password; it does NOT prove the user
    controls the email address. Per migration policy we therefore do not infer
    email ownership from the hash — every migrated user is created with
    email_verified=false and must confirm their email via the Cognito
    invitation flow on first sign-in. (`member` is accepted for signature
    stability / future per-user policy.)
    """
    return False


def _attributes_for(member: TeamMember, email_verified: bool) -> list[dict]:
    attrs = [
        {"Name": "email", "Value": member.email},
        {"Name": "email_verified", "Value": "true" if email_verified else "false"},
    ]
    if member.name:
        attrs.append({"Name": "name", "Value": member.name})
    if member.phone_number:
        attrs.append({"Name": "phone_number", "Value": member.phone_number})
        # Never confirmed by the legacy system.
        attrs.append({"Name": "phone_number_verified", "Value": "false"})
    return attrs


class CognitoAdminClient:
    """Thin wrapper over boto3 cognito-idp admin calls used by the migration.

    Kept tiny and dependency-injected so tests can substitute a fake. Only the
    operations the dedicated migration IAM role is granted are used here:
    AdminCreateUser, AdminGetUser, ListUsers.
    """

    def __init__(self, user_pool_id: str, client):
        self.user_pool_id = user_pool_id
        self._client = client

    def create_user_with_invite(self, email: str, attributes: list[dict]) -> str:
        """Create a user (temporary-password invitation email) and return its sub."""
        from botocore.exceptions import ClientError

        try:
            resp = self._client.admin_create_user(
                UserPoolId=self.user_pool_id,
                Username=email,
                UserAttributes=attributes,
                DesiredDeliveryMediums=["EMAIL"],
                # MessageAction omitted -> Cognito SENDS the invitation email.
            )
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") == "UsernameExistsException":
                raise UsernameExistsError(email) from error
            raise
        return _extract_sub(resp["User"]["Attributes"])

    def get_user_sub(self, email: str) -> str:
        resp = self._client.admin_get_user(
            UserPoolId=self.user_pool_id, Username=email
        )
        return _extract_sub(resp["UserAttributes"])


def _extract_sub(attributes: list[dict]) -> str:
    for attr in attributes:
        if attr.get("Name") == "sub":
            return attr["Value"]
    raise KeyError("Cognito response did not contain a 'sub' attribute.")


def migrate_users(db, cognito: CognitoAdminClient, *, apply: bool = False) -> MigrationReport:
    """Migrate all eligible team_members into Cognito. Pure + testable.

    ``db`` is a SQLAlchemy session; ``cognito`` is a CognitoAdminClient (real or
    fake). With ``apply=False`` (default) no Cognito writes and no DB writes
    occur — the report records what WOULD happen.
    """
    report = MigrationReport(dry_run=not apply)
    members = db.query(TeamMember).order_by(TeamMember.id).all()

    for member in members:
        # 1. Idempotent skip: already linked.
        if member.cognito_sub:
            report.add(UserResult(member.id, member.email, STATUS_ALREADY_LINKED,
                                   reason="cognito_sub already set",
                                   cognito_sub=member.cognito_sub))
            continue
        # 2. Eligibility.
        if not member.is_active:
            report.add(UserResult(member.id, member.email, STATUS_SKIPPED,
                                   reason="inactive account"))
            continue
        if not member.email:
            report.add(UserResult(member.id, member.email or "", STATUS_SKIPPED,
                                   reason="missing email"))
            continue
        if not member.password_hash:
            # Seed-style / never-authenticated row: do not provision silently.
            report.add(UserResult(member.id, member.email, STATUS_SKIPPED,
                                   reason="no password_hash (never authenticated); migrate manually"))
            continue

        email_verified = _email_is_reliably_verified(member)

        # 3. Dry-run: plan only.
        if not apply:
            report.add(UserResult(member.id, member.email, STATUS_WOULD_CREATE,
                                   reason="eligible", email_verified=email_verified))
            continue

        # 4. Apply.
        try:
            try:
                sub = cognito.create_user_with_invite(
                    member.email, _attributes_for(member, email_verified)
                )
                status = STATUS_CREATED
            except UsernameExistsError:
                # Idempotent: link the existing Cognito user instead of duplicating.
                sub = cognito.get_user_sub(member.email)
                status = STATUS_LINKED_EXISTING

            # Only ever fill a NULL cognito_sub; never overwrite.
            member.cognito_sub = sub
            db.commit()
            report.add(UserResult(member.id, member.email, status,
                                   reason="", cognito_sub=sub,
                                   email_verified=email_verified))
        except Exception as error:  # per-user isolation: one failure never aborts the run
            db.rollback()
            report.add(UserResult(member.id, member.email, STATUS_FAILED,
                                   reason=f"{type(error).__name__}: {error}"))

    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _build_real_client(user_pool_id: str, region: str) -> CognitoAdminClient:
    import boto3

    return CognitoAdminClient(user_pool_id, boto3.client("cognito-idp", region_name=region))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Idempotent bulk migration of team_members into Cognito "
                    "(DRY-RUN by default; pass --apply to make changes).",
    )
    parser.add_argument("--apply", action="store_true",
                        help="Actually create/link users. Without this, runs read-only.")
    parser.add_argument("--user-pool-id", default=os.getenv("COGNITO_USER_POOL_ID", ""),
                        help="Cognito User Pool ID (or COGNITO_USER_POOL_ID env).")
    parser.add_argument("--region", default=os.getenv("AWS_REGION", ""),
                        help="AWS region (or AWS_REGION env).")
    parser.add_argument("--report-file", default=None,
                        help="Write the JSON report to this path (also printed to stdout).")
    args = parser.parse_args(argv)

    if not args.user_pool_id or not args.region:
        print("Error: --user-pool-id/COGNITO_USER_POOL_ID and --region/AWS_REGION are required.",
              file=sys.stderr)
        return 2

    cognito = _build_real_client(args.user_pool_id, args.region)
    db = SessionLocal()
    try:
        report = migrate_users(db, cognito, apply=args.apply)
    finally:
        db.close()

    payload = report.to_json()
    print(payload)
    if args.report_file:
        with open(args.report_file, "w", encoding="utf-8") as handle:
            handle.write(payload)

    mode = "APPLIED" if args.apply else "DRY-RUN (no changes made)"
    print(f"\n{mode}. Summary: {report.summary()}", file=sys.stderr)
    # Non-zero exit if any row failed, so CI/automation notices.
    return 1 if any(r.status == STATUS_FAILED for r in report.results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
