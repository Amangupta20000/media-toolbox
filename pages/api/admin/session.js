import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "media-toolbox-admin-session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const ADMIN_USERNAME = "Admin";

function configuredPassword() {
  return String(process.env.ADMIN_PASSWORD || "Aman");
}

function sessionSecret() {
  return String(process.env.ADMIN_SESSION_SECRET || configuredPassword());
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload) {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function sessionToken() {
  const payload = encode(JSON.stringify({ username: ADMIN_USERNAME, expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000 }));
  return `${payload}.${sign(payload)}`;
}

function cookieValue(request) {
  const header = String(request.headers.cookie || "");
  const entry = header.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${COOKIE_NAME}=`));
  return entry ? decodeURIComponent(entry.slice(COOKIE_NAME.length + 1)) : "";
}

export function validSession(request) {
  const token = cookieValue(request);
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const actualSignature = Buffer.from(signature);
  const expectedSignature = Buffer.from(sign(payload));
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.username === ADMIN_USERNAME && Number(parsed.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

function passwordMatches(value) {
  const actual = Buffer.from(String(value || ""));
  const expected = Buffer.from(configuredPassword());
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function secureCookie(request) {
  return request.headers["x-forwarded-proto"] === "https" || Boolean(request.socket?.encrypted);
}

function setSessionCookie(response, request, token, maxAge = SESSION_TTL_SECONDS) {
  const secure = secureCookie(request) ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure}`);
}

const AUDIO_GRANT_TTL_SECONDS = 90;

function signAudioGrant(payload) {
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${sign(encoded)}`;
}

export function createAdminAudioGrant({ challenge, origin } = {}) {
  const expiresAt = Date.now() + AUDIO_GRANT_TTL_SECONDS * 1000;
  return signAudioGrant({ kind: "audio-url-admin", challenge: String(challenge || ""), origin: String(origin || ""), expiresAt });
}

export function verifyAdminAudioGrant(value) {
  const [payload, signature] = String(value || "").split(".");
  if (!payload || !signature) return null;
  const actualSignature = Buffer.from(signature);
  const expectedSignature = Buffer.from(sign(payload));
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed.kind !== "audio-url-admin" || !parsed.challenge || !parsed.origin || Number(parsed.expiresAt) <= Date.now()) return null;
    return { challenge: String(parsed.challenge), origin: String(parsed.origin), expiresAt: Number(parsed.expiresAt) };
  } catch {
    return null;
  }
}

function json(response, status, payload) {
  response.status(status).setHeader("Cache-Control", "no-store").json(payload);
}

export default function handler(request, response) {
  if (request.method === "GET") return validSession(request) ? json(response, 200, { authenticated: true }) : json(response, 401, { authenticated: false });

  if (request.method === "DELETE") {
    setSessionCookie(response, request, "", 0);
    return json(response, 200, { authenticated: false });
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST, DELETE");
    return json(response, 405, { error: "Method not allowed." });
  }

  const body = typeof request.body === "string" ? (() => { try { return JSON.parse(request.body); } catch { return {}; } })() : request.body || {};
  if (String(body.username || "") !== ADMIN_USERNAME || !passwordMatches(body.password)) return json(response, 401, { error: "The Admin username or password is incorrect." });
  setSessionCookie(response, request, sessionToken());
  return json(response, 200, { authenticated: true });
}
