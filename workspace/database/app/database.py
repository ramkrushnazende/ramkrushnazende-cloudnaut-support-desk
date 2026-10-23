import os
from urllib.parse import quote_plus

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.orm import sessionmaker, declarative_base

from app.secrets import get_secret

# Use a persistent temp file inside the container for SQLite fallback
def _database_url() -> str:
    configured = os.getenv("DATABASE_URL", "").strip()
    if configured:
        return configured
    proxy_endpoint = os.getenv("DB_PROXY_ENDPOINT", "").strip()
    secret_arn = os.getenv("DB_SECRET_ARN", "").strip()
    if proxy_endpoint and secret_arn:
        secret = get_secret(secret_arn)
        username = quote_plus(secret.get("username", ""))
        password = quote_plus(secret.get("password", ""))
        database_name = os.getenv("DB_NAME", secret.get("dbname", ""))
        return f"postgresql+psycopg2://{username}:{password}@{proxy_endpoint}:5432/{database_name}"
    return "sqlite:////tmp/support_desk.db"


DATABASE_URL = _database_url()


class DatabaseConfigurationError(RuntimeError):
    """Raised when DATABASE_URL is missing required parts (e.g. a bad port).

    Gives a clear, credential-free message instead of SQLAlchemy's cryptic
    ``ValueError: invalid literal for int() with base 10: 'null'`` when the
    deployment hands us a URL such as ``...@host:null/db``.
    """


def _validate_database_url(raw_url: str) -> None:
    """Fail fast on a structurally invalid DATABASE_URL without leaking secrets.

    Only the scheme and the *presence* of host/port are reported; the username,
    password, host value, and full URL are never included in the message.
    """
    if not raw_url or not raw_url.strip():
        raise DatabaseConfigurationError("DATABASE_URL is not set.")
    try:
        url = make_url(raw_url)
    except ArgumentError as error:
        # str(error) can echo the URL (with credentials); do not include it.
        raise DatabaseConfigurationError(
            "DATABASE_URL is malformed and could not be parsed."
        ) from error

    backend = url.get_backend_name()
    if backend == "sqlite":
        return

    if not url.host:
        raise DatabaseConfigurationError(
            f"DATABASE_URL ({backend}) is missing a database host. "
            "This usually means the database secret was read before it was "
            "fully populated (missing 'host' field)."
        )
    # make_url raises on a non-numeric port before we get here; this guards the
    # 'port absent / resolved to a non-integer' case defensively.
    if url.port is None:
        raise DatabaseConfigurationError(
            f"DATABASE_URL ({backend}) is missing a valid numeric port. "
            "This usually means the database secret was read before it was "
            "fully populated (missing or 'null' 'port' field)."
        )


# make_url() itself raises on a non-numeric port like 'null'; wrap it so the
# failure is a clear, credential-free DatabaseConfigurationError.
try:
    _validate_database_url(DATABASE_URL)
except DatabaseConfigurationError:
    raise
except (ArgumentError, ValueError) as _error:
    raise DatabaseConfigurationError(
        "DATABASE_URL is invalid (could not parse host/port). Verify the "
        "database secret is fully populated."
    ) from _error


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
else:
    # Production (Aurora PostgreSQL) engine settings. All values are overridable
    # via environment variables; nothing about the Aurora host/user/password/db
    # is hardcoded (that lives entirely in DATABASE_URL).
    connect_args: dict = {}
    if DATABASE_URL.startswith("postgresql"):
        # Enforce TLS to Aurora unless explicitly overridden. psycopg2 honours
        # libpq's sslmode; "require" encrypts without local CA verification,
        # which matches a typical Aurora client setup.
        connect_args["sslmode"] = os.getenv("DB_SSLMODE", "require")
        connect_args["connect_timeout"] = _int_env("DB_CONNECT_TIMEOUT", 10)

    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,  # drop stale connections (Aurora idle timeouts/failover)
        pool_size=_int_env("DB_POOL_SIZE", 5),
        max_overflow=_int_env("DB_MAX_OVERFLOW", 10),
        pool_recycle=_int_env("DB_POOL_RECYCLE", 1800),
        pool_timeout=_int_env("DB_POOL_TIMEOUT", 30),
        connect_args=connect_args,
    )

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
