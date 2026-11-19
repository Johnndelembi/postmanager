import os
import unittest
from unittest.mock import patch

from postmanager.auth import AuthError, SESSION_IDLE_SECONDS, make_session, normalize_phone, read_session, session_cookie


class AuthBoundaryTests(unittest.TestCase):
    def test_local_phone_and_non_ascii_digits(self):
        self.assertEqual(normalize_phone("0712 345 678"), "255712345678")
        with self.assertRaises(AuthError):
            normalize_phone("+٢٥٥٧١٢٣٤٥٦٧٨")

    def test_session_tampering_and_cookie_flags(self):
        with patch.dict(os.environ, {"SESSION_SECRET": "test-secret-" * 4}):
            token = make_session(42)
            self.assertEqual(read_session(token), 42)
            self.assertIsNone(read_session(token + "x"))
            self.assertIsNone(read_session("x" * 513))
            cookie = session_cookie(token, secure=True)
            self.assertIn("HttpOnly", cookie)
            self.assertIn("Secure", cookie)
            self.assertIn("SameSite=Lax", cookie)

    def test_session_expires(self):
        with patch.dict(os.environ, {"SESSION_SECRET": "test-secret-" * 4}):
            with patch("postmanager.auth.time.time", return_value=1_000_000):
                token = make_session(42)
            with patch("postmanager.auth.time.time", return_value=1_000_000 + SESSION_IDLE_SECONDS + 1):
                self.assertIsNone(read_session(token))


if __name__ == "__main__":
    unittest.main()
