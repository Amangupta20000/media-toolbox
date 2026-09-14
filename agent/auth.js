import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config, paths } from "../lib/config.js";
import { createAgentAuth, getAgentAuth, hasUsedAgentLicense, recordUsedAgentLicense, updateAgentAuth } from "../lib/db.js";
import { activationDurationOptions, isAllowedActivationDuration, verifyLicenseToken } from "./token.js";
import { DEFAULT_LICENSE_PROXY_URL } from "./license-proxy.cjs";

export const ADMIN_USERNAME = "Admin";
export const ADMIN_PASSWORD = "Aman";
const LEGACY_ADMIN_PASSWORD = "12345";
export const TRIAL_DURATION_MS = 5 * 60 * 1000;
export const ACTIVATION_DURATION_MS = 10 * 60 * 1000;
// Offline tester access intentionally bypasses the online licensing server.
// Keep this code limited to controlled testing builds; every redemption starts
// a fresh ten-minute activation and is not recorded as a one-use license.
export const TESTER_ACTIVATION_CODE = "iamatester";
export const TESTER_ACTIVATION_DURATION_MS = 10 * 60 * 1000;
export const ACTIVATION_FREE_SESSION_LIMIT = 2;
export const ACTIVATION_SESSION_TIME_FACTOR = 2 / 3;
export const LEGAL_VERSION = "1.0.0";

const DEFAULT_ORIGINS = [
  "https://media-toolbox-woad.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

let onlineLicenseAdminToken = "";
let licenseServerFetch = typeof fetch === "function" ? fetch.bind(globalThis) : null;
const LICENSE_ADMIN_SESSION_FILE = "license-admin-session.json";

function licenseAdminSessionPath() {
  return path.join(config.dataDir, LICENSE_ADMIN_SESSION_FILE);
}

function clearPersistedLicenseAdminSession() {
  try { fs.rmSync(licenseAdminSessionPath(), { force: true }); } catch { /* a missing or locked session file is harmless */ }
}

function restorePersistedLicenseAdminSession() {
  if (onlineLicenseAdminToken) return;
  let session;
  try {
    session = JSON.parse(fs.readFileSync(licenseAdminSessionPath(), "utf8"));
  } catch {
    return;
  }
  const token = typeof session?.token === "string" ? session.token.trim() : "";
  const expiresAt = Number(session?.expiresAt);
  if (!token || token.length > 4096 || (Number.isFinite(expiresAt) && expiresAt <= Date.now())) {
    clearPersistedLicenseAdminSession();
    return;
  }
  onlineLicenseAdminToken = token;
}

function persistLicenseAdminSession(token, expiresAt) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const filename = licenseAdminSessionPath();
  fs.writeFileSync(filename, `${JSON.stringify({ token, expiresAt: Number.isFinite(Number(expiresAt)) ? Number(expiresAt) : null })}\n`, { mode: 0o600 });
  fs.chmodSync(filename, 0o600);
}

// Packaged Electron uses Chromium's network stack for licensing requests so
// certificate and proxy handling matches the browser. Source/CLI execution
// continues to use the standard Node fetch implementation.
export function setLicenseServerFetchImplementation(fetchImplementation) {
  if (typeof fetchImplementation !== "function") throw new Error("The licensing-server fetch implementation is invalid.");
  licenseServerFetch = fetchImplementation;
}

function passwordHash(password, salt) {
  return scryptSync(String(password), salt, 64, { N: 16_384, r: 8, p: 1 }).toString("base64");
}

function passwordMatches(password, salt, expectedHash) {
  try {
    const actual = Buffer.from(passwordHash(password, salt), "base64");
    const expected = Buffer.from(expectedHash, "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function normalizeOrigin(value) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch { return ""; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
  return parsed.origin;
}

export function defaultTrustedOrigins() {
  return [...DEFAULT_ORIGINS];
}

function normalizeOrigins(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizeOrigin).filter(Boolean))];
}

function publicKeyCandidates() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const configured = process.env.AGENT_LICENSE_PUBLIC_KEY_FILE || "";
  return [
    configured,
    process.env.AGENT_LICENSE_PUBLIC_KEY || "",
    path.join(config.dataDir, "license-public-key.pem"),
    path.join(config.dataDir, "license-public.pem"),
    path.join(os.homedir(), ".config", "media-toolbox", "agent-license-public.pem"),
    path.join(moduleDirectory, "license-public-key.pem"),
  ].filter(Boolean);
}

function packagedLicenseServerUrl() {
  // The file is a release-time asset. Do not let a generated ignored file in
  // the source checkout change Node-based development/test behavior; Electron
  // provides resourcesPath for packaged agents.
  if (!process.resourcesPath && process.env.AGENT_PACKAGED_CONFIG !== "1") return "";
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  try { return fs.readFileSync(path.join(moduleDirectory, "license-server-url.txt"), "utf8").trim().replace(/\/$/, ""); } catch { return ""; }
}

function readPublicKey() {
  for (const candidate of publicKeyCandidates()) {
    if (candidate.includes("BEGIN PUBLIC KEY")) return candidate;
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf8");
    } catch { /* try the next configured location */ }
  }
  return "";
}

export function ensureAgentAuth() {
  let record = getAgentAuth();
  if (!record) {
    const salt = randomBytes(16).toString("base64");
    createAgentAuth({
      deviceId: randomUUID(),
      username: ADMIN_USERNAME,
      passwordSalt: salt,
      passwordHash: passwordHash(ADMIN_PASSWORD, salt),
    });
    record = getAgentAuth();
  } else if (record.username === ADMIN_USERNAME && passwordMatches(LEGACY_ADMIN_PASSWORD, record.password_salt, record.password_hash)) {
    const salt = randomBytes(16).toString("base64");
    record = updateAgentAuth({ passwordSalt: salt, passwordHash: passwordHash(ADMIN_PASSWORD, salt) });
  }
  return record;
}

function clearExpiredAuthorization(record, now) {
  if (record.activation_expires_at && record.activation_expires_at <= now) {
    return updateAgentAuth({
      activationId: null,
      activationStartedAt: null,
      activationExpiresAt: null,
      activationOriginsJson: "[]",
      activationCodeHash: null,
      activationSessionActive: 1,
    });
  }
  return record;
}

function hasLegalConsent(record) {
  return Boolean(
    record.privacy_accepted_at &&
    record.terms_accepted_at &&
    record.privacy_version === LEGAL_VERSION &&
    record.terms_version === LEGAL_VERSION,
  );
}

function activationTiming(record, now, sessionCount = 0) {
  const originalExpiresAt = record.activation_expires_at || null;
  const available = Boolean(record.activation_id && originalExpiresAt && originalExpiresAt > now);
  if (!available) return { available: false, originalExpiresAt: null, originalRemainingMs: null, effectiveExpiresAt: null, effectiveRemainingMs: null, penaltyCount: 0 };
  const originalRemainingMs = Math.max(0, originalExpiresAt - now);
  const count = Number.isInteger(Number(sessionCount)) ? Number(sessionCount) : 0;
  const penaltyCount = Math.max(0, count - ACTIVATION_FREE_SESSION_LIMIT);
  const effectiveRemainingMs = Math.floor(originalRemainingMs * (ACTIVATION_SESSION_TIME_FACTOR ** penaltyCount));
  return {
    available: true,
    originalExpiresAt,
    originalRemainingMs,
    effectiveExpiresAt: now + effectiveRemainingMs,
    effectiveRemainingMs,
    penaltyCount,
  };
}

function authorizationMode(record, now, legalAccepted = hasLegalConsent(record), sessionCount = 0) {
  if (!legalAccepted) return "locked";
  if (record.admin_unlocked) return "admin";
  const activation = activationTiming(record, now, sessionCount);
  if (activation.available) {
    if (activation.effectiveRemainingMs <= 0) return "locked";
    return record.activation_session_active === 0 ? "locked" : "activation";
  }
  if (record.trial_started_at && record.trial_started_at + TRIAL_DURATION_MS > now) return "trial";
  return "locked";
}

export function getAuthorizationState(now = Date.now(), sessionCount = 0) {
  let record = ensureAgentAuth();
  record = clearExpiredAuthorization(record, now);
  const legalAccepted = hasLegalConsent(record);
  const mode = authorizationMode(record, now, legalAccepted, sessionCount);
  const trialExpiresAt = record.trial_started_at ? record.trial_started_at + TRIAL_DURATION_MS : null;
  const activation = activationTiming(record, now, sessionCount);
  const activationAvailable = activation.available;
  const activationLoggedOut = activationAvailable && record.activation_session_active === 0;
  const activationOrigins = JSON.parse(record.activation_origins_json || "[]").filter(Boolean);
  const trustedOrigins = activationAvailable ? activationOrigins : defaultTrustedOrigins();
  const activationSessionLimitReached = activationAvailable && record.activation_session_active !== 0 && activation.effectiveRemainingMs <= 0;
  const expiresAt = mode === "trial"
    ? trialExpiresAt
    : mode === "activation"
      ? activation.effectiveExpiresAt
      : activationLoggedOut
        ? activation.originalExpiresAt
        : activationSessionLimitReached
          ? activation.effectiveExpiresAt
          : null;
  const trialAvailable = !record.trial_started_at && !record.trial_consumed;
  return {
    mode,
    authorized: mode !== "locked",
    reason: mode === "locked" ? (!legalAccepted ? "legal_consent_required" : activationLoggedOut ? "activation_logged_out" : activationSessionLimitReached ? "activation_session_limit" : record.trial_consumed || record.trial_started_at ? "trial_expired" : "authorization_required") : "authorized",
    legalAccepted,
    legalVersion: legalAccepted ? LEGAL_VERSION : null,
    legalAcceptedAt: legalAccepted ? Math.min(record.privacy_accepted_at, record.terms_accepted_at) : null,
    deviceId: record.device_id,
    username: record.username,
    adminUnlocked: Boolean(record.admin_unlocked),
    trustedOrigins,
    trialStartedAt: record.trial_started_at || null,
    trialExpiresAt,
    trialAvailable,
    activationId: activationAvailable ? record.activation_id : null,
    activationStartedAt: activationAvailable ? record.activation_started_at : null,
    activationExpiresAt: activationAvailable ? record.activation_expires_at : null,
    activationSessionActive: activationAvailable ? record.activation_session_active !== 0 : false,
    activationReloginAvailable: activationLoggedOut,
    activationOriginalRemainingMs: activation.originalRemainingMs,
    activationEffectiveExpiresAt: activation.effectiveExpiresAt,
    activationEffectiveRemainingMs: activation.effectiveRemainingMs,
    activationSessionPenaltyCount: activation.penaltyCount,
    activationSessionLimitReached,
    expiresAt,
    remainingMs: expiresAt ? Math.max(0, expiresAt - now) : null,
  };
}

export function acceptLegalConsent(now = Date.now()) {
  // The desktop dashboard can be opened before the first health request, so
  // initialize the persistent auth row before recording consent.
  ensureAgentAuth();
  updateAgentAuth({
    privacyAcceptedAt: now,
    privacyVersion: LEGAL_VERSION,
    termsAcceptedAt: now,
    termsVersion: LEGAL_VERSION,
  });
  return getAuthorizationState(now);
}

export function startTrial(now = Date.now()) {
  const current = requireLegalConsent();
  if (current.mode !== "locked") return current;
  if (!current.trialAvailable) {
    const error = new Error("The five-minute trial has already been used or expired. Admin login or activation is required.");
    error.code = "activation_required";
    error.authorization = current;
    throw error;
  }
  updateAgentAuth({ trialStartedAt: now, trialConsumed: 1 });
  return getAuthorizationState(now);
}

function requireLegalConsent() {
  const state = getAuthorizationState();
  if (state.legalAccepted) return state;
  const error = new Error("Accept the Privacy Policy and Terms & Conditions in the local agent dashboard before continuing.");
  error.code = "legal_consent_required";
  error.authorization = state;
  throw error;
}

export function isTrustedOrigin(origin, state = getAuthorizationState()) {
  const normalized = normalizeOrigin(origin);
  return Boolean(normalized && state.trustedOrigins.includes(normalized));
}

export function authorizeProcessing(origin, now = Date.now(), sessionCount = 0) {
  let state = getAuthorizationState(now, sessionCount);
  if (!isTrustedOrigin(origin, state)) return { ok: false, code: "origin_not_trusted", state };
  if (!state.legalAccepted) return { ok: false, code: "legal_consent_required", state };
  if (state.authorized) return { ok: true, state };

  const record = ensureAgentAuth();
  if (!record.trial_started_at && !record.trial_consumed) {
    updateAgentAuth({ trialStartedAt: now, trialConsumed: 1 });
    state = getAuthorizationState(now, sessionCount);
    return { ok: true, state };
  }
  return { ok: false, code: "activation_required", state };
}

export function loginAdmin(username, password) {
  requireLegalConsent();
  const record = ensureAgentAuth();
  const valid = String(username || "") === record.username && passwordMatches(password, record.password_salt, record.password_hash);
  if (!valid) throw new Error("The Admin username or password is incorrect.");
  updateAgentAuth({ adminUnlocked: 1 });
  return getAuthorizationState();
}

export function logoutAdmin() {
  updateAgentAuth({ adminUnlocked: 0 });
  return getAuthorizationState();
}

export function logoutActivation(now = Date.now()) {
  const current = getAuthorizationState(now);
  if (!current.activationExpiresAt) return current;
  updateAgentAuth({ activationSessionActive: 0 });
  return getAuthorizationState(now);
}

export function loginActivation(now = Date.now()) {
  requireLegalConsent();
  const current = getAuthorizationState(now);
  if (!current.activationExpiresAt || !current.activationReloginAvailable) {
    if (current.mode === "activation") return current;
    const error = new Error("No active activation session is available to log in again.");
    error.code = "activation_required";
    error.authorization = current;
    throw error;
  }
  updateAgentAuth({ activationSessionActive: 1 });
  return getAuthorizationState(now);
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "="), "base64");
}

function parseActivationCode(code) {
  const raw = String(code || "").trim();
  if (!raw.startsWith("MT1-")) throw new Error("Activation codes must start with MT1-.");
  const value = raw.slice(4).replace(/-/g, "");
  const separator = value.indexOf(".");
  if (separator < 1) throw new Error("The activation code is incomplete.");
  const payloadText = value.slice(0, separator);
  const signature = decodeBase64Url(value.slice(separator + 1));
  let payload;
  try { payload = JSON.parse(decodeBase64Url(payloadText).toString("utf8")); } catch { throw new Error("The activation code payload is invalid."); }
  const publicKey = readPublicKey();
  if (!publicKey) throw new Error("Activation is not configured on this agent. The owner must embed the license public key before packaging.");
  let validSignature = false;
  try { validSignature = verify(null, Buffer.from(payloadText), publicKey, signature); } catch { validSignature = false; }
  if (!validSignature) throw new Error("The activation code signature is invalid.");
  return payload;
}

export function activate(code, now = Date.now()) {
  requireLegalConsent();
  const record = ensureAgentAuth();
  const payload = parseActivationCode(code);
  return activateVerifiedPayload(payload, code, record, now);
}

export function activateTester(code, now = Date.now()) {
  requireLegalConsent();
  if (String(code || "").trim() !== TESTER_ACTIVATION_CODE) {
    throw new Error("The offline tester activation code is invalid.");
  }
  const record = ensureAgentAuth();
  updateAgentAuth({
    activationId: `tester-${randomUUID()}`,
    activationStartedAt: now,
    activationExpiresAt: now + TESTER_ACTIVATION_DURATION_MS,
    activationOriginsJson: JSON.stringify(defaultTrustedOrigins()),
    activationCodeHash: createHash("sha256").update(TESTER_ACTIVATION_CODE).digest("hex"),
    activationSessionActive: 1,
  });
  return getAuthorizationState(now);
}

function activateVerifiedPayload(payload, code, record, now) {
  if (payload.v !== 1 || typeof payload.licenseId !== "string") throw new Error("The activation code format is invalid.");
  // The local used-license table prevents replay on this installation. The
  // device binding prevents the same signed code being copied elsewhere.
  if (typeof payload.deviceId !== "string" || !payload.deviceId.trim()) throw new Error("This activation code is not bound to a device.");
  if (payload.deviceId !== record.device_id) throw new Error("This activation code belongs to a different device.");
  if (!isAllowedActivationDuration(payload.durationMs)) throw new Error("This activation code contains an unsupported duration.");
  if (!Array.isArray(payload.origins) || !normalizeOrigins(payload.origins).length) throw new Error("The activation code has no valid trusted website origins.");
  if (hasUsedAgentLicense(payload.licenseId) || record.activation_id === payload.licenseId) throw new Error("This activation code has already been used.");
  if (payload.issuedAt && Number(payload.issuedAt) > now + 5 * 60 * 1000) throw new Error("This activation code is not valid yet.");
  const origins = normalizeOrigins(payload.origins);
  const codeHash = createHash("sha256").update(String(code).replace(/\s+/g, "")).digest("hex");
  recordUsedAgentLicense(payload.licenseId, now);
  updateAgentAuth({
    activationId: payload.licenseId,
    activationStartedAt: now,
    activationExpiresAt: now + Number(payload.durationMs),
    activationOriginsJson: JSON.stringify(origins),
    activationCodeHash: codeHash,
    activationSessionActive: 1,
  });
  return getAuthorizationState(now);
}

export function hasOnlineLicenseServer() {
  return Boolean(onlineLicenseServerUrl() || localLicenseServerUrl());
}

export function onlineLicenseServerUrl() {
  return String(process.env.AGENT_LICENSE_SERVER_URL || process.env.NEXT_PUBLIC_LICENSE_SERVER_URL || packagedLicenseServerUrl()).trim().replace(/\/$/, "");
}

function localLicenseServerUrl() {
  return String(process.env.AGENT_LICENSE_SERVER_LOCAL_URL || "").trim().replace(/\/$/, "");
}

function onlineLicenseUrls(pathname) {
  const publicUrl = onlineLicenseServerUrl();
  const proxyUrl = publicUrl && !/^https?:\/\/127\.0\.0\.1(?::|\/)/i.test(publicUrl) && !/^https?:\/\/localhost(?::|\/)/i.test(publicUrl)
    ? String(process.env.AGENT_LICENSE_SERVER_PROXY_URL || DEFAULT_LICENSE_PROXY_URL).trim().replace(/\/$/, "")
    : "";
  const localUrl = localLicenseServerUrl();
  // Packaged client installations should not wait on an unreachable Tailscale
  // Funnel before using the website's same-origin proxy. The owner Mac still
  // uses its loopback service first, and every path retains the direct URL as
  // a fallback if the website is unavailable.
  const preferProxy = Boolean(process.resourcesPath && !localUrl);
  const configuredUrls = [localUrl, ...(preferProxy ? [proxyUrl] : []), publicUrl, ...(preferProxy ? [] : [proxyUrl])].filter(Boolean);
  if (!configuredUrls.length) throw new Error("The online licensing server is not configured on this agent.");
  return [...new Set(configuredUrls)].map((serverUrl) => {
    let parsed;
    try { parsed = new URL(serverUrl); } catch { throw new Error("The online licensing server URL is invalid."); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("The online licensing server URL must use HTTP or HTTPS.");
    return `${serverUrl}${pathname}`;
  });
}

function auditDeviceHeaders() {
  const record = ensureAgentAuth();
  const deviceName = String(os.hostname() || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  return {
    "X-Media-Toolbox-Device-Id": String(record.device_id || "").slice(0, 200),
    "X-Media-Toolbox-Device-Name": deviceName,
    "X-Media-Toolbox-OS": process.platform,
  };
}

async function onlineLicenseFetch(pathname, options = {}) {
  let lastError;
  const attempts = [];
  for (const requestUrl of onlineLicenseUrls(pathname)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      if (typeof licenseServerFetch !== "function") throw new Error("This agent cannot make licensing-server requests.");
      const response = await licenseServerFetch(requestUrl, {
        cache: "no-store",
        ...options,
        headers: { ...auditDeviceHeaders(), ...(options.headers || {}) },
        signal: controller.signal,
      });
      let body = {};
      try { body = await response.json(); } catch { /* report the status below */ }
      if (!response.ok) {
        const error = new Error(body.error || `The licensing server rejected the request (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error("The licensing server request timed out.") : error;
      attempts.push({ url: requestUrl, message: lastError?.message || "The request failed.", status: lastError?.status || null });
    } finally {
      clearTimeout(timeout);
    }
  }
  if (attempts.length > 1 || lastError?.name === "TypeError") {
    const details = attempts.map(({ url, message }) => `${url}: ${message}`).join(" | ");
    const error = new Error(`The licensing server could not be reached. ${details} Check that the owner's licensing server and public HTTPS endpoint are running. If this hostname is unfamiliar or outdated, install the latest agent release.`);
    error.cause = lastError;
    error.attempts = attempts;
    throw error;
  }
  throw lastError || new Error("The licensing server request failed.");
}

function requestOrigin(value) {
  const origin = normalizeOrigin(value);
  if (!origin) throw new Error("Enter a valid website origin, such as https://media-toolbox-woad.vercel.app.");
  return origin;
}

export function getLicenseRequestConfig() {
  return {
    available: hasOnlineLicenseServer(),
    serverUrl: onlineLicenseServerUrl() || localLicenseServerUrl(),
    localServerUrl: localLicenseServerUrl(),
    suggestedOrigins: defaultTrustedOrigins(),
    allowedDurations: activationDurationOptions(),
  };
}

export async function requestActivationCode(origin, requesterLabel = "Local agent dashboard", durationMs = ACTIVATION_DURATION_MS) {
  requireLegalConsent();
  const normalizedOrigin = requestOrigin(origin);
  if (!isAllowedActivationDuration(durationMs)) throw new Error("Choose an activation duration of 10 minutes, 30 minutes, 2 hours, 6 hours, or 1 day.");
  const label = String(requesterLabel || "Local agent dashboard").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Local agent dashboard";
  return onlineLicenseFetch("/v1/license-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin: normalizedOrigin, requesterLabel: label, durationMs: Number(durationMs) }),
  });
}

export async function getActivationRequestStatus(requestId, requestToken) {
  const id = String(requestId || "").trim();
  const token = String(requestToken || "").trim();
  if (!id || !token) throw new Error("The activation request is incomplete.");
  return onlineLicenseFetch(`/v1/license-requests/${encodeURIComponent(id)}`, {
    headers: { "X-Request-Token": token },
  });
}

export async function activateOnline(code, now = Date.now()) {
  requireLegalConsent();
  const record = ensureAgentAuth();
  try {
    const body = await onlineLicenseFetch("/v1/licenses/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: String(code || "").trim(), deviceId: record.device_id }),
    });
    if (!body.token) throw new Error("The licensing server did not return a bound activation token.");
    const publicKey = readPublicKey();
    if (!publicKey) throw new Error("Activation is not configured on this agent. The owner must embed the license public key before packaging.");
    const payload = verifyLicenseToken(body.token, publicKey);
    if (!isAllowedActivationDuration(payload.durationMs)) throw new Error("The licensing server returned an invalid activation duration.");
    if (payload.deviceId !== record.device_id) throw new Error("The licensing server returned a token for a different device.");
    return activateVerifiedPayload(payload, body.token, record, now);
  } catch (error) {
    throw error;
  }
}

export function getLicenseAdminState() {
  restorePersistedLicenseAdminSession();
  return { authenticated: Boolean(onlineLicenseAdminToken) };
}

export async function loginLicenseAdmin(username, password) {
  const body = await onlineLicenseFetch("/v1/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: String(username || ""), password: String(password || "") }),
  });
  if (!body.token) throw new Error("The licensing server did not return an Admin session.");
  onlineLicenseAdminToken = body.token;
  persistLicenseAdminSession(onlineLicenseAdminToken, body.expiresAt);
  return getLicenseAdminState();
}

export async function logoutLicenseAdmin() {
  restorePersistedLicenseAdminSession();
  const token = onlineLicenseAdminToken;
  onlineLicenseAdminToken = "";
  clearPersistedLicenseAdminSession();
  if (!token) return getLicenseAdminState();
  try {
    await onlineLicenseFetch("/v1/admin/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  } catch { /* local logout still clears the in-memory licensing session */ }
  return getLicenseAdminState();
}

function onlineLicenseAdminOptions(options = {}) {
  restorePersistedLicenseAdminSession();
  if (!onlineLicenseAdminToken) throw new Error("Log in as Admin in the local agent dashboard to view license requests.");
  return { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${onlineLicenseAdminToken}` } };
}

async function onlineLicenseAdminFetch(pathname, options = {}) {
  try {
    return await onlineLicenseFetch(pathname, onlineLicenseAdminOptions(options));
  } catch (error) {
    // A licensing server can expire or revoke a persisted session while the
    // local Admin authorization remains valid. Forget the stale bearer token
    // so the next dashboard action asks for a fresh licensing login instead
    // of repeatedly sending a known-invalid session.
    if (Number(error?.status) === 401) {
      onlineLicenseAdminToken = "";
      clearPersistedLicenseAdminSession();
    }
    throw error;
  }
}

export async function getLicenseAdminRequests() {
  return onlineLicenseAdminFetch("/v1/admin/license-requests");
}

export async function getLicenseAdminAudit(limit = 200) {
  const safeLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 200));
  return onlineLicenseAdminFetch(`/v1/admin/audit-log?limit=${safeLimit}`);
}

export async function approveLicenseRequest(requestId) {
  return onlineLicenseAdminFetch(`/v1/admin/license-requests/${encodeURIComponent(String(requestId || ""))}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

export async function declineLicenseRequest(requestId, reason = "Declined by owner") {
  return onlineLicenseAdminFetch(`/v1/admin/license-requests/${encodeURIComponent(String(requestId || ""))}/decline`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
}

export function getDeviceId() {
  return ensureAgentAuth().device_id;
}

export function getLicensePublicKeyStatus() {
  return { configured: Boolean(readPublicKey()) };
}
