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
SECRET_KEY = os.environ.get("CHEF_SECRET_KEY", "change-me-in-production")
SESSION_COOKIE = "chef_session"
SESSION_MAX_AGE = int(os.environ.get("CHEF_SESSION_MAX_AGE", str(30 * 24 * 3600)))  # 30 days

_signer = TimestampSigner(SECRET_KEY)
_users: dict[str, str] = {}  # username -> bcrypt hash


def load_users(path: str | Path | None = None) -> None:
    """Load user list from TOML file."""
    global _users
    if path is None:
        path = Path(__file__).parent / "users.toml"
    path = Path(path)

    if not path.exists():
        log.warning("No users.toml found at %s — auth will reject everyone", path)
        return

    with open(path, "rb") as f:
        data = tomllib.load(f)

    _users = {}
    for username, info in data.get("users", {}).items():
        pw_hash = info.get("password_hash", "")
        if "PLACEHOLDER" in pw_hash:
            log.warning("User '%s' has a placeholder hash — they can't log in", username)
            continue
        _users[username] = pw_hash

    log.info("Loaded %d user(s) from %s", len(_users), path)


def verify_password(username: str, password: str) -> bool:
    """Check username/password against loaded users."""
    pw_hash = _users.get(username)
    if pw_hash is None:
        return False
    return bcrypt.checkpw(password.encode("utf-8"), pw_hash.encode("utf-8"))


def create_session(username: str) -> str:
    """Create a signed session cookie value."""
    return _signer.sign(username).decode("utf-8")


def validate_session(cookie_value: str) -> str | None:
    """Validate a session cookie. Returns username or None."""
    try:
        username = _signer.unsign(cookie_value, max_age=SESSION_MAX_AGE).decode("utf-8")
        if username in _users:
            return username
        return None
    except (BadSignature, SignatureExpired):
        return None
