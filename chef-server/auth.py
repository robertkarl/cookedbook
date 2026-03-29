"""
CookedBook Chef — authentication module.

Session cookies signed with itsdangerous, passwords checked with bcrypt.
Users defined in users.toml.
"""

import logging
import os
import tomllib
from pathlib import Path

import bcrypt
from itsdangerous import TimestampSigner, BadSignature, SignatureExpired

log = logging.getLogger("chef.auth")

# Config
SESSION_COOKIE = "chef_session"
SESSION_MAX_AGE = int(os.environ.get("CHEF_SESSION_MAX_AGE", str(30 * 24 * 3600)))  # 30 days

_DEFAULT_SECRET = "change-me-in-production"
_signer = None
_users: dict[str, str] = {}  # username -> bcrypt hash
_DUMMY_HASH = bcrypt.hashpw(b"dummy", bcrypt.gensalt()).decode("utf-8")


def _get_signer() -> TimestampSigner:
    """Lazy-init the signer so it picks up CHEF_SECRET_KEY at runtime, not import time."""
    global _signer
    if _signer is None:
        key = os.environ.get("CHEF_SECRET_KEY", _DEFAULT_SECRET)
        if not key or key == _DEFAULT_SECRET:
            log.critical(
                "CHEF_SECRET_KEY is not set, empty, or is the default! "
                "Sessions will be signed with a publicly known key. "
                "Set CHEF_SECRET_KEY to a random value: "
                "python3 -c \"import secrets; print(secrets.token_hex(32))\""
            )
            if not key:
                key = _DEFAULT_SECRET
        _signer = TimestampSigner(key)
    return _signer


def load_users(path: str | Path | None = None) -> None:
    """Load user list from TOML file."""
    global _users
    if path is None:
        path = Path(__file__).parent / "users.toml"
    path = Path(path)

    if not path.exists():
        log.warning("No users.toml found at %s — auth will reject everyone", path)
        _users = {}
        return

    try:
        with open(path, "rb") as f:
            data = tomllib.load(f)
    except Exception as e:
        log.error("Failed to parse %s: %s — auth will reject everyone", path, e)
        _users = {}
        return

    _users = {}
    for username, info in data.get("users", {}).items():
        pw_hash = info.get("password_hash", "")
        if "PLACEHOLDER" in pw_hash:
            log.warning("User '%s' has a placeholder hash — they can't log in", username)
            continue
        if not pw_hash.startswith("$2"):
            log.warning("User '%s' has invalid bcrypt hash — skipping", username)
            continue
        _users[username] = pw_hash

    log.info("Loaded %d user(s) from %s", len(_users), path)


def verify_password(username: str, password: str) -> bool:
    """Check username/password against loaded users."""
    pw_hash = _users.get(username)
    if pw_hash is None:
        # Constant-time: run bcrypt against dummy hash to prevent timing enumeration
        try:
            bcrypt.checkpw(password.encode("utf-8"), _DUMMY_HASH.encode("utf-8"))
        except (ValueError, TypeError):
            pass
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), pw_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_session(username: str) -> str:
    """Create a signed session cookie value."""
    return _get_signer().sign(username).decode("utf-8")


def validate_session(cookie_value: str) -> str | None:
    """Validate a session cookie. Returns username or None."""
    try:
        username = _get_signer().unsign(cookie_value, max_age=SESSION_MAX_AGE).decode("utf-8")
        if username in _users:
            return username
        return None
    except (BadSignature, SignatureExpired):
        return None
