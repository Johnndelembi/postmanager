import assert from "node:assert/strict";
import test from "node:test";

import { getAuthenticatedUser, handleAuth, renewSessionCookie } from "../netlify/lib/auth.js";

const PYTHON_SESSION = "NDI6MTA4NjQwMA.02ae4a14bf9f070609b996318682e8d08ee9d1171fac529cb8f4297310b7da07";
const TEST_SECRET = "test-secret-".repeat(4);

test("Netlify signs the same secure session cookie as Python", () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousNow = Date.now;
  process.env.SESSION_SECRET = TEST_SECRET;
  Date.now = () => 1_000_000_000;
  try {
    assert.equal(
      renewSessionCookie(42, new Request("https://example.test/api/me")),
      `postmanager_session=${PYTHON_SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure`,
    );
  } finally {
    Date.now = previousNow;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("Netlify rejects tampered and expired Python sessions before database access", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousNow = Date.now;
  process.env.SESSION_SECRET = TEST_SECRET;
  try {
    Date.now = () => 1_000_000_000;
    const tampered = new Request("https://example.test/api/me", {
      headers: { Cookie: `postmanager_session=${PYTHON_SESSION.slice(0, -1)}0` },
    });
    await assert.rejects(getAuthenticatedUser(tampered), { status: 401 });

    Date.now = () => 1_086_401_000;
    const expired = new Request("https://example.test/api/me", {
      headers: { Cookie: `postmanager_session=${PYTHON_SESSION}` },
    });
    await assert.rejects(getAuthenticatedUser(expired), { status: 401 });
  } finally {
    Date.now = previousNow;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test("logout clears the session cookie", async () => {
  const request = new Request("https://example.test/api/logout", { method: "POST" });
  const response = await handleAuth(request, "/api/logout");
  assert.equal(response?.status, 200);
  assert.match(response?.headers.get("set-cookie") ?? "", /postmanager_session=;.*Max-Age=0; Secure/);
});

test("phone OTP rejects non-ASCII digits before sending an SMS", async () => {
  const request = new Request("https://example.test/api/auth/request-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "+٢٥٥٧١٢٣٤٥٦٧٨" }),
  });
  await assert.rejects(handleAuth(request, "/api/auth/request-otp"), { status: 400 });
});
