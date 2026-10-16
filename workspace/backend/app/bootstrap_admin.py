"""One-time command to create the first Cloudnaut administrator account.

Run inside the backend container (or any trusted environment configured with
the production DATABASE_URL):

    python -m app.bootstrap_admin --name "Jane Admin" --email jane@example.com

The password is never passed as an argument or printed; it is read
interactively via getpass. The command is idempotent-safe: it refuses to create
a duplicate account for an existing email. It does NOT run during application
startup — it must be invoked explicitly.
"""
import argparse
import sys
from getpass import getpass

from sqlalchemy.exc import SQLAlchemyError

from app.auth import hash_password
from database.app.database import SessionLocal
from database.app.models import TeamMember

MIN_PASSWORD_LENGTH = 12


def _fail(message: str) -> "None":
    """Print a clear error to stderr and exit non-zero (no secrets in message)."""
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(1)


def _normalize_email(raw_email: str) -> str:
    email = (raw_email or "").strip().lower()
    # Minimal structural validation consistent with the rest of the app
    # (see main.py create_access_request): a single '@' with non-empty parts.
    if email.count("@") != 1 or email.startswith("@") or email.endswith("@") or " " in email:
        _fail("A valid email address is required.")
    if len(email) > 255:
        _fail("Email must be 255 characters or fewer.")
    return email


def _prompt_password() -> str:
    password = getpass(f"New admin password ({MIN_PASSWORD_LENGTH}+ characters): ")
    confirmation = getpass("Confirm password: ")
    if len(password) < MIN_PASSWORD_LENGTH:
        _fail(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.")
    if password != confirmation:
        _fail("Passwords do not match.")
    return password


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create the first Cloudnaut administrator account.",
    )
    parser.add_argument("--name", required=True, help="Administrator display name.")
    parser.add_argument("--email", required=True, help="Administrator login email.")
    args = parser.parse_args()

    name = (args.name or "").strip()
    if not name or len(name) > 100:
        _fail("Name must be between 1 and 100 characters.")

    email = _normalize_email(args.email)

    # Prompt for the password only after cheap validation passes, so the user
    # isn't asked to type a password for an obviously-invalid invocation.
    password = _prompt_password()

    db = SessionLocal()
    try:
        existing = (
            db.query(TeamMember)
            .filter(TeamMember.email.ilike(email))
            .first()
        )
        if existing is not None:
            _fail("An account with this email already exists.")

        member = TeamMember(
            name=name,
            email=email,
            role="admin",
            password_hash=hash_password(password),
            is_active=True,
        )
        db.add(member)
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        # Re-raise as a clear, credential-free message. The original exception
        # is chained for operators but the printed line stays generic.
        _fail(f"Database error while creating the administrator: {type(error).__name__}.")
    finally:
        db.close()

    print(f"Administrator account created for {email}.")


if __name__ == "__main__":
    main()
