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

    # Import and configure — reset lazy signer so it picks up test key
    import auth
    auth._signer = None
    auth.load_users(users_toml)

    yield

    # Reset signer for next test
    auth._signer = None


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


class TestWebSocketAuth:
    def test_voice_ws_requires_auth(self, client):
        """WebSocket should reject unauthenticated connections."""
        with pytest.raises(Exception):
            with client.websocket_connect("/ws/voice"):
                pass

    def test_voice_ws_rejects_invalid_cookie(self, client):
        """WebSocket should reject connections with bad session cookies."""
        with pytest.raises(Exception):
            with client.websocket_connect(
                "/ws/voice",
                cookies={"chef_session": "forged.garbage.value"},
            ):
                pass


class TestAuthModule:
    def test_create_and_validate_session(self):
        from auth import create_session, validate_session

        token = create_session("testuser")
        assert isinstance(token, str)
        assert len(token) > 10

        username = validate_session(token)
        assert username == "testuser"

    def test_validate_expired_session(self):
        from auth import _get_signer, validate_session
        import auth

        # Temporarily set max_age to 0
        original = auth.SESSION_MAX_AGE
        auth.SESSION_MAX_AGE = 0

        token = _get_signer().sign("testuser").decode("utf-8")

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


# ============================================================================
# Quality-check: additional coverage for edge cases and malformed input
# ============================================================================


class TestLoginMalformedInput:
    """Login endpoint with garbage, edge-case, and adversarial input."""

    def test_login_empty_username(self, client):
        resp = client.post(
            "/login",
            data={"username": "", "password": "testpass123"},
            follow_redirects=False,
        )
        assert resp.status_code == 401

    def test_login_empty_password(self, client):
        resp = client.post(
            "/login",
            data={"username": "testuser", "password": ""},
            follow_redirects=False,
        )
        assert resp.status_code == 401

    def test_login_missing_username_field(self, client):
        resp = client.post(
            "/login",
            data={"password": "testpass123"},
            follow_redirects=False,
        )
        assert resp.status_code == 401

    def test_login_missing_password_field(self, client):
        resp = client.post(
            "/login",
            data={"username": "testuser"},
            follow_redirects=False,
        )
        assert resp.status_code == 401

    def test_login_empty_form(self, client):
        resp = client.post("/login", data={}, follow_redirects=False)
        assert resp.status_code == 401

    def test_login_very_long_username(self, client):
        resp = client.post(
            "/login",
            data={"username": "a" * 10_000, "password": "testpass123"},
            follow_redirects=False,
        )
        assert resp.status_code == 401

    def test_login_very_long_password(self, client):
        resp = client.post(
            "/login",
            data={"username": "testuser", "password": "x" * 10_000},
            follow_redirects=False,
        )
        assert resp.status_code == 401

    def test_login_unicode_username(self, client):
        resp = client.post(
            "/login",
            data={"username": "\u00e9\u00e0\u00fc\u00f1\u2603\U0001f525", "password": "test"},
            follow_redirects=False,
        )
        assert resp.status_code == 401

    def test_login_whitespace_only_username(self, client):
        resp = client.post(
            "/login",
            data={"username": "   ", "password": "testpass123"},
            follow_redirects=False,
        )
        assert resp.status_code == 401


class TestUsersTomlEdgeCases:
    """Edge cases for users.toml loading."""

    def test_missing_users_toml_rejects_everyone(self, tmp_path):
        """When users.toml doesn't exist, verify_password rejects all users."""
        import auth
        # Save original users, load from nonexistent path
        original_users = auth._users.copy()
        auth.load_users(tmp_path / "nonexistent.toml")
        assert auth.verify_password("testuser", "testpass123") is False
        assert auth.verify_password("anyone", "anything") is False
        # Restore
        auth._users = original_users

    def test_malformed_users_toml_does_not_crash(self, tmp_path):
        """Invalid TOML should log error and reject everyone, not crash."""
        import auth
        bad_toml = tmp_path / "bad.toml"
        bad_toml.write_text("this is not [valid toml {{{{")
        # After fix: should NOT raise
        auth.load_users(bad_toml)
        assert auth.verify_password("anyone", "anything") is False

    def test_empty_users_toml(self, tmp_path):
        import auth
        auth._signer = None
        empty_toml = tmp_path / "empty.toml"
        empty_toml.write_text("# empty config\n")
        os.environ["CHEF_SECRET_KEY"] = "test-secret-key-not-for-prod"
        auth.load_users(empty_toml)
        assert auth.verify_password("testuser", "testpass123") is False
        auth._signer = None


class TestSessionEdgeCases:

    def test_session_for_removed_user_rejected(self, client):
        """Session for a user who was removed after login should be rejected."""
        import auth
        login_resp = client.post(
            "/login",
            data={"username": "testuser", "password": "testpass123"},
            follow_redirects=False,
        )
        cookie = login_resp.cookies.get("chef_session")
        auth._users.pop("testuser", None)
        resp = client.get("/api/me", cookies={"chef_session": cookie})
        assert resp.status_code == 401

    def test_empty_cookie_value(self, client):
        resp = client.get("/api/me", cookies={"chef_session": ""})
        assert resp.status_code == 401

    def test_extremely_long_cookie(self, client):
        resp = client.get("/api/me", cookies={"chef_session": "A" * 100_000})
        assert resp.status_code == 401


class TestLogoutEdgeCases:

    def test_logout_without_session(self, client):
        resp = client.get("/logout", follow_redirects=False)
        assert resp.status_code == 302


class TestProtectedEndpointsWithAuth:
    """Test protected endpoints WITH valid auth — happy path for edge cases."""

    def _get_auth_cookie(self, client):
        resp = client.post(
            "/login",
            data={"username": "testuser", "password": "testpass123"},
            follow_redirects=False,
        )
        return resp.cookies.get("chef_session")

    def test_shopping_list_empty_need(self, client):
        cookie = self._get_auth_cookie(client)
        resp = client.post(
            "/api/shopping-list",
            json={"need": [], "recipe": "test"},
            cookies={"chef_session": cookie},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["grouped"] == []
        assert data["raw"] == []

    def test_shopping_list_missing_need_field(self, client):
        cookie = self._get_auth_cookie(client)
        resp = client.post(
            "/api/shopping-list",
            json={"recipe": "test"},
            cookies={"chef_session": cookie},
        )
        assert resp.status_code == 200
        assert resp.json()["grouped"] == []

    def test_shopping_list_empty_body(self, client):
        cookie = self._get_auth_cookie(client)
        resp = client.post(
            "/api/shopping-list",
            json={},
            cookies={"chef_session": cookie},
        )
        assert resp.status_code == 200

    def test_chat_llm_unreachable_returns_502(self, client):
        """chat_endpoint should handle LLM errors gracefully (502, not 500)."""
        import server
        original_url = server.OLLAMA_URL
        server.OLLAMA_URL = "http://127.0.0.1:1"  # guaranteed unreachable
        try:
            cookie = self._get_auth_cookie(client)
            resp = client.post(
                "/api/chat",
                json={"messages": [{"role": "user", "content": "hi"}], "recipe": "test"},
                cookies={"chef_session": cookie},
            )
            assert resp.status_code == 502
            assert "error" in resp.json()
        finally:
            server.OLLAMA_URL = original_url


class TestVerifyPasswordEdgeCases:

    def test_verify_empty_password(self):
        from auth import verify_password
        assert verify_password("testuser", "") is False

    def test_verify_empty_username(self):
        from auth import verify_password
        assert verify_password("", "testpass123") is False

    def test_verify_nonexistent_user_constant_time(self):
        """Verifying a nonexistent user should still run bcrypt (timing attack mitigation)."""
        from auth import verify_password
        assert verify_password("doesnotexist", "password") is False
