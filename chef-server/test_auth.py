"""
Smoke tests for CookedBook Chef auth endpoints and health.

Run: cd chef-server && python -m pytest test_auth.py -v

These tests use FastAPI's TestClient — no running server or ML models needed.
"""

import os
import tempfile

import bcrypt
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def setup_env(tmp_path):
    """Set up a temp users.toml and configure env before importing the app."""
    # Generate a real bcrypt hash
    password = b"testpass123"
    hashed = bcrypt.hashpw(password, bcrypt.gensalt()).decode("utf-8")

    users_toml = tmp_path / "users.toml"
    users_toml.write_text(
        f'[users.testuser]\npassword_hash = "{hashed}"\n'
        f'\n[users.baduser]\npassword_hash = "$2b$12$PLACEHOLDER_HASH_CHANGE_ME"\n'
    )

    # Set env vars before importing the app
    os.environ["CHEF_SECRET_KEY"] = "test-secret-key-not-for-prod"
    os.environ["CHEF_USERS_FILE"] = str(users_toml)

    # Import and configure
    import auth
    auth.load_users(users_toml)

    yield


@pytest.fixture
def client():
    """Create a test client that doesn't load ML models."""
    from server import app
    return TestClient(app)


class TestHealth:
    def test_health_returns_ok(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "model" in data
        assert "whisper" in data
        assert "uptime_seconds" in data

    def test_health_no_auth_required(self, client):
        """Health endpoint should work without authentication."""
        resp = client.get("/health")
        assert resp.status_code == 200


class TestLogin:
    def test_login_page_returns_html(self, client):
        resp = client.get("/login", follow_redirects=False)
        assert resp.status_code == 200
        assert "Sign In" in resp.text

    def test_login_success_sets_cookie(self, client):
        resp = client.post(
            "/login",
            data={"username": "testuser", "password": "testpass123"},
            follow_redirects=False,
        )
        assert resp.status_code == 302
        assert "chef_session" in resp.cookies

    def test_login_wrong_password(self, client):
        resp = client.post(
            "/login",
            data={"username": "testuser", "password": "wrongpassword"},
            follow_redirects=False,
        )
        assert resp.status_code == 401
        assert "Bad username or password" in resp.text

    def test_login_nonexistent_user(self, client):
        resp = client.post(
            "/login",
            data={"username": "nobody", "password": "whatever"},
            follow_redirects=False,
        )
        assert resp.status_code == 401

    def test_login_placeholder_user_rejected(self, client):
        """Users with PLACEHOLDER hashes should not be able to log in."""
        resp = client.post(
            "/login",
            data={"username": "baduser", "password": "anything"},
            follow_redirects=False,
        )
        assert resp.status_code == 401

    def test_login_case_insensitive(self, client):
        resp = client.post(
            "/login",
            data={"username": "TestUser", "password": "testpass123"},
            follow_redirects=False,
        )
        assert resp.status_code == 302

    def test_already_logged_in_redirects(self, client):
        # Log in first
        login_resp = client.post(
            "/login",
            data={"username": "testuser", "password": "testpass123"},
            follow_redirects=False,
        )
        cookie = login_resp.cookies.get("chef_session")

        # Visit login page while authenticated
        resp = client.get("/login", cookies={"chef_session": cookie}, follow_redirects=False)
        assert resp.status_code == 302


class TestMe:
    def test_me_unauthenticated(self, client):
        resp = client.get("/api/me")
        assert resp.status_code == 401
        assert resp.json()["authenticated"] is False

    def test_me_authenticated(self, client):
        # Log in
        login_resp = client.post(
            "/login",
            data={"username": "testuser", "password": "testpass123"},
            follow_redirects=False,
        )
        cookie = login_resp.cookies.get("chef_session")

        resp = client.get("/api/me", cookies={"chef_session": cookie})
        assert resp.status_code == 200
        data = resp.json()
        assert data["authenticated"] is True
        assert data["username"] == "testuser"

    def test_me_invalid_cookie(self, client):
        resp = client.get("/api/me", cookies={"chef_session": "garbage.value"})
        assert resp.status_code == 401


class TestLogout:
    def test_logout_clears_cookie(self, client):
        # Log in
        login_resp = client.post(
            "/login",
            data={"username": "testuser", "password": "testpass123"},
            follow_redirects=False,
        )
        cookie = login_resp.cookies.get("chef_session")

        # Logout
        resp = client.get("/logout", cookies={"chef_session": cookie}, follow_redirects=False)
        assert resp.status_code == 302
        # Cookie should be deleted (set to empty or max_age=0)
        assert "chef_session" in resp.headers.get("set-cookie", "")


class TestProtectedEndpoints:
    def test_chat_requires_auth(self, client):
        resp = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hi"}], "recipe": "test"},
        )
        assert resp.status_code == 401

    def test_shopping_list_requires_auth(self, client):
        resp = client.post(
            "/api/shopping-list",
            json={"need": ["eggs"], "recipe": "test"},
        )
        assert resp.status_code == 401


class TestAuthModule:
    def test_create_and_validate_session(self):
        from auth import create_session, validate_session

        token = create_session("testuser")
        assert isinstance(token, str)
        assert len(token) > 10

        username = validate_session(token)
        assert username == "testuser"

    def test_validate_expired_session(self):
        from auth import _signer, validate_session
        import auth

        # Temporarily set max_age to 0
        original = auth.SESSION_MAX_AGE
        auth.SESSION_MAX_AGE = 0

        token = _signer.sign("testuser").decode("utf-8")

        import time
        time.sleep(1)

        result = validate_session(token)
        assert result is None

        auth.SESSION_MAX_AGE = original

    def test_validate_tampered_session(self):
        from auth import create_session, validate_session

        token = create_session("testuser")
        tampered = token[:-5] + "XXXXX"
        assert validate_session(tampered) is None

    def test_verify_password(self):
        from auth import verify_password

        assert verify_password("testuser", "testpass123") is True
        assert verify_password("testuser", "wrongpass") is False
        assert verify_password("nonexistent", "testpass123") is False
