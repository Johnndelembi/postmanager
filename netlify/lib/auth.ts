import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { getContext } from "@netlify/functions";

import { getPool } from "./db.js";
import { ApiError, json } from "./http.js";

const COOKIE_NAME = "postmanager_session";
const SESSION_IDLE_SECONDS = 24 * 60 * 60;
const OTP_TTL_SECONDS = 60;
const OTP_RESEND_SECONDS = 60;
const OTP_HOURLY_LIMIT = 4;
const OTP_MAX_ATTEMPTS = 5;
const IP_HOURLY_LIMIT = 30;
const DEFAULT_DAILY_LIMIT = 1000;
const BEEM_SEND_URL = "https://apisms.beem.africa/v1/send";
const UNCERTAIN_SEND = "Beem did not confirm whether it accepted this verification code. Check before requesting another code.";

type User = { id: number; phone: string };

class DeliveryError extends ApiError {
  constructor(message: string, readonly uncertain: boolean) {
    super(502, message);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ApiError(503, `${name} is not configured.`);
  return value;
}

function secret(): string {
  const value = requiredEnv("SESSION_SECRET");
  if (Buffer.byteLength(value) < 32) throw new ApiError(503, "SESSION_SECRET must be at least 32 bytes.");
  return value;
}

function digest(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

function normalizePhone(value: unknown): string {
  let phone = String(value ?? "").trim().replace(/[\s().-]/g, "");
  if (phone.startsWith("+")) phone = phone.slice(1);
  if (phone.startsWith("0") && !phone.startsWith("00")) phone = `255${phone.slice(1)}`;
  if (!/^[0-9]{8,15}$/.test(phone)) {
    throw new ApiError(400, "Enter a valid phone number with its country code, or a local number starting with 0.");
  }
  return phone;
}

function positiveSafeInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function sessionToken(userId: number): string {
  if (!positiveSafeInteger(userId)) throw new Error("userId must be a positive safe integer");
  const value = Buffer.from(`${userId}:${Math.floor(Date.now() / 1000) + SESSION_IDLE_SECONDS}`, "ascii").toString("base64url");
  return `${value}.${digest(`session:${value}`)}`;
}

function readSession(token: string | null): number | null {
  if (!token || token.length > 512 || !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(token)) return null;
  const [value, signature] = token.split(".");
  const expected = digest(`session:${value}`);
  if (!timingSafeEqual(Buffer.from(signature, "ascii"), Buffer.from(expected, "ascii"))) return null;
  const payload = Buffer.from(value, "base64url").toString("ascii");
  const match = /^(\d+):(\d+)$/.exec(payload);
  if (!match) return null;
  const userId = positiveSafeInteger(match[1]);
  const expires = Number(match[2]);
  const now = Math.floor(Date.now() / 1000);
  return userId && Number.isSafeInteger(expires) && expires >= now && expires <= now + SESSION_IDLE_SECONDS
    ? userId
    : null;
}

function cookieValue(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return null;
}

function sessionCookie(token: string, request: Request, maxAge = SESSION_IDLE_SECONDS): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function renewSessionCookie(userId: number, request: Request): string {
  return sessionCookie(sessionToken(userId), request);
}

export async function getAuthenticatedUser(request: Request): Promise<User> {
  const userId = readSession(cookieValue(request));
  if (!userId) throw new ApiError(401, "Sign in to continue.");
  const result = await getPool().query<{ id: string; phone: string }>(
    "SELECT id, phone FROM users WHERE id = $1",
    [userId],
  );
  const row = result.rows[0];
  const id = row ? positiveSafeInteger(row.id) : null;
  if (!id) throw new ApiError(401, "Sign in to continue.");
  return { id, phone: row.phone };
}

function dailyLimit(): number {
  const raw = process.env.OTP_DAILY_LIMIT ?? String(DEFAULT_DAILY_LIMIT);
  const value = Number(raw);
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new ApiError(503, "OTP_DAILY_LIMIT must be a positive integer.");
  }
  return value;
}

function clientIp(): string {
  const ip = getContext().ip;
  if (!ip) throw new ApiError(503, "Client IP is unavailable.");
  return ip;
}

async function requestOtp(value: unknown): Promise<Record<string, unknown>> {
  const phone = normalizePhone(value);
  const source = requiredEnv("BEEM_SOURCE_ADDR");
  const credentials = requiredEnv("BEEM_AUTHORIZATION");
  const separator = credentials.indexOf(":");
  if (separator < 1 || separator === credentials.length - 1) {
    throw new ApiError(503, "BEEM_AUTHORIZATION must contain an API key and secret separated by a colon.");
  }
  const limit = dailyLimit();
  const now = Math.floor(Date.now() / 1000);
  const code = String(randomInt(1_000_000)).padStart(6, "0");
  const ip = clientIp();
  const client = await getPool().connect();
  let challengeId: string;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [phone]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["postmanager:otp:daily"]);
    const windowStart = now - (now % 3600);
    const ipHash = digest(`ip:${ip}`);
    await client.query("DELETE FROM otp_ip_rate_limits WHERE window_start < $1", [windowStart - 24 * 3600]);
    const rate = await client.query(
      `INSERT INTO otp_ip_rate_limits(ip_hash, window_start, attempts) VALUES ($1, $2, 1)
       ON CONFLICT (ip_hash, window_start) DO UPDATE
       SET attempts = otp_ip_rate_limits.attempts + 1
       WHERE otp_ip_rate_limits.attempts < $3 RETURNING attempts`,
      [ipHash, windowStart, IP_HOURLY_LIMIT],
    );
    if (!rate.rows.length) {
      throw new ApiError(429, "Too many verification codes were requested from this network. Try again in an hour.",
        Math.max(1, windowStart + 3600 - now));
    }
    await client.query("DELETE FROM otp_challenges WHERE sent_at < $1", [now - 24 * 3600]);
    const daily = await client.query<{ count: string; oldest: string | null }>(
      "SELECT COUNT(*) AS count, MIN(sent_at) AS oldest FROM otp_challenges WHERE sent_at > $1",
      [now - 24 * 3600],
    );
    if (Number(daily.rows[0].count) >= limit) {
      throw new ApiError(429, "The daily verification-code limit has been reached. Try again later.",
        Math.max(1, Number(daily.rows[0].oldest) + 24 * 3600 - now));
    }
    const latest = await client.query<{ sent_at: string }>(
      "SELECT sent_at FROM otp_challenges WHERE phone = $1 ORDER BY sent_at DESC, id DESC LIMIT 1",
      [phone],
    );
    const recent = await client.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM otp_challenges WHERE phone = $1 AND sent_at > $2",
      [phone, now - 3600],
    );
    const lastSent = latest.rows[0] ? Number(latest.rows[0].sent_at) : null;
    if (lastSent !== null && now - lastSent < OTP_RESEND_SECONDS) {
      const wait = Math.max(1, OTP_RESEND_SECONDS - (now - lastSent));
      throw new ApiError(429, `Please wait ${wait} seconds before requesting another code.`, wait);
    }
    if (Number(recent.rows[0].count) >= OTP_HOURLY_LIMIT) {
      throw new ApiError(429, "Too many codes requested. Try again in an hour.",
        lastSent === null ? 3600 : Math.max(1, lastSent + 3600 - now));
    }
    const inserted = await client.query<{ id: string }>(
      "INSERT INTO otp_challenges(phone, otp_hash, sent_at, expires_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [phone, digest(`otp:${phone}:${code}`), now, now + OTP_TTL_SECONDS],
    );
    challengeId = inserted.rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  try {
    await sendCode(phone, code, source, credentials);
  } catch (error) {
    if (error instanceof DeliveryError && !error.uncertain) {
      await getPool().query("DELETE FROM otp_challenges WHERE id = $1", [challengeId]);
    }
    throw error;
  }
  const elapsed = Math.floor(Date.now() / 1000) - now;
  return {
    ok: true,
    challenge_id: positiveSafeInteger(challengeId),
    expires_in: Math.max(0, OTP_TTL_SECONDS - elapsed),
    resend_in: Math.max(0, OTP_RESEND_SECONDS - elapsed),
  };
}

async function sendCode(phone: string, code: string, source: string, credentials: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(BEEM_SEND_URL, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Basic ${Buffer.from(credentials).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        source_addr: source,
        schedule_time: "",
        encoding: 0,
        message: `Your Postmanager verification code is ${code}. It expires in 60 seconds.`,
        recipients: [{ recipient_id: 1, dest_addr: phone }],
      }),
    });
  } catch {
    throw new DeliveryError(UNCERTAIN_SEND, true);
  }
  if (!response.ok) {
    throw new DeliveryError(response.status >= 500 ? UNCERTAIN_SEND : "Beem rejected the verification code request.",
      response.status >= 500);
  }
  let data: unknown;
  try {
    const raw = await response.text();
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new DeliveryError(UNCERTAIN_SEND, true);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new DeliveryError(UNCERTAIN_SEND, true);
  }
  if ("successful" in data && data.successful === false) {
    throw new DeliveryError("Beem could not send the verification code.", false);
  }
}

async function verifyOtp(phoneValue: unknown, codeValue: unknown): Promise<User> {
  const phone = normalizePhone(phoneValue);
  const code = String(codeValue ?? "").trim();
  if (!/^[0-9]{6}$/.test(code)) throw new ApiError(400, "Enter the six-digit code from your SMS.");
  const now = Math.floor(Date.now() / 1000);
  const client = await getPool().connect();
  let user: User | null = null;
  let incorrect = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [phone]);
    const challenges = await client.query<{
      id: string; otp_hash: string; sent_at: string; expires_at: string; attempts: number;
    }>(
      `SELECT id, otp_hash, sent_at, expires_at, attempts FROM otp_challenges
       WHERE phone = $1 AND used_at IS NULL ORDER BY sent_at DESC, id DESC LIMIT 1 FOR UPDATE`,
      [phone],
    );
    const challenge = challenges.rows[0];
    if (!challenge || Number(challenge.expires_at) <= now || Number(challenge.sent_at) + OTP_TTL_SECONDS <= now) {
      throw new ApiError(400, "That code has expired. Request a new one.");
    }
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      throw new ApiError(429, "Too many incorrect codes. Request a new one in a minute.");
    }
    const supplied = digest(`otp:${phone}:${code}`);
    const stored = challenge.otp_hash;
    if (!/^[0-9a-f]{64}$/.test(stored) ||
      !timingSafeEqual(Buffer.from(stored, "ascii"), Buffer.from(supplied, "ascii"))) {
      await client.query("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1", [challenge.id]);
      incorrect = true;
    } else {
      await client.query("UPDATE otp_challenges SET used_at = $1 WHERE id = $2", [now, challenge.id]);
      await client.query(
        `INSERT INTO users(phone, created_at, last_activity_at) VALUES ($1, $2, $3)
         ON CONFLICT (phone) DO NOTHING`,
        [phone, now, now],
      );
      const users = await client.query<{ id: string; phone: string }>(
        "UPDATE users SET last_activity_at = GREATEST(last_activity_at, $1) WHERE phone = $2 RETURNING id, phone",
        [now, phone],
      );
      const row = users.rows[0];
      const id = row ? positiveSafeInteger(row.id) : null;
      if (!id) throw new Error("User id is outside JavaScript's safe integer range");
      user = { id, phone: row.phone };
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (incorrect || !user) throw new ApiError(400, "That code does not match. Check the SMS and try again.");
  return user;
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    throw new ApiError(415, "Send JSON with Content-Type: application/json.");
  }
  const length = Number(request.headers.get("content-length"));
  if (length > 1_000_000) throw new ApiError(413, "Request is too large.");
  let value: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 1_000_000) throw new ApiError(413, "Request is too large.");
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Request body must be valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export async function handleAuth(request: Request, pathname: string): Promise<Response | null> {
  if (pathname === "/api/auth/request-otp") {
    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await bodyObject(request);
    return json(200, await requestOtp(body.phone), { "Cache-Control": "no-store" });
  }
  if (pathname === "/api/auth/verify-otp") {
    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    const body = await bodyObject(request);
    const user = await verifyOtp(body.phone, body.code);
    return json(200, user, { "Set-Cookie": renewSessionCookie(user.id, request), "Cache-Control": "no-store" });
  }
  if (pathname === "/api/me") {
    if (request.method !== "GET") throw new ApiError(405, "Method not allowed.");
    const user = await getAuthenticatedUser(request);
    return json(200, user, { "Set-Cookie": renewSessionCookie(user.id, request), "Cache-Control": "no-store" });
  }
  if (pathname === "/api/logout") {
    if (request.method !== "POST") throw new ApiError(405, "Method not allowed.");
    return json(200, { ok: true }, { "Set-Cookie": sessionCookie("", request, 0), "Cache-Control": "no-store" });
  }
  return null;
}
