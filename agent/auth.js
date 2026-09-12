import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config, paths } from "../lib/config.js";
import { createAgentAuth, getAgentAuth, hasUsedAgentLicense, recordUsedAgentLicense, updateAgentAuth } from "../lib/db.js";

export const ADMIN_USERNAME = "Admin";
export const TRIAL_DURATION_MS = 5 * 60 * 1000;
export const ACTIVATION_DURATION_MS = 10 * 60 * 1000;
export const LEGAL_VERSION = "1.0.0";

const DEFAULT_ORIGINS = [
  "https://media-toolbox-woad.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

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
      passwordHash: passwordHash("12345", salt),
    });
    record = getAgentAuth();
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

function authorizationMode(record, now, legalAccepted = hasLegalConsent(record)) {
  if (!legalAccepted) return "locked";
  if (record.admin_unlocked) return "admin";
  if (record.activation_expires_at && record.activation_expires_at > now) return "activation";
  if (record.trial_started_at && record.trial_started_at + TRIAL_DURATION_MS > now) return "trial";
  return "locked";
}

export function getAuthorizationState(now = Date.now()) {
  let record = ensureAgentAuth();
  record = clearExpiredAuthorization(record, now);
  const legalAccepted = hasLegalConsent(record);
  const mode = authorizationMode(record, now, legalAccepted);
  const trialExpiresAt = record.trial_started_at ? record.trial_started_at + TRIAL_DURATION_MS : null;
  const activeActivation = mode === "activation";
  const trustedOrigins = activeActivation
    ? (JSON.parse(record.activation_origins_json || "[]").filter(Boolean))
    : defaultTrustedOrigins();
  const expiresAt = mode === "trial" ? trialExpiresAt : activeActivation ? record.activation_expires_at : null;
  const trialAvailable = !record.trial_started_at && !record.trial_consumed;
  return {
    mode,
    authorized: mode !== "locked",
    reason: mode === "locked" ? (!legalAccepted ? "legal_consent_required" : record.trial_consumed || record.trial_started_at ? "trial_expired" : "authorization_required") : "authorized",
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
    activationId: activeActivation ? record.activation_id : null,
    activationStartedAt: activeActivation ? record.activation_started_at : null,
    activationExpiresAt: activeActivation ? record.activation_expires_at : null,
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

export function authorizeProcessing(origin, now = Date.now()) {
  let state = getAuthorizationState(now);
  if (!isTrustedOrigin(origin, state)) return { ok: false, code: "origin_not_trusted", state };
  if (!state.legalAccepted) return { ok: false, code: "legal_consent_required", state };
  if (state.authorized) return { ok: true, state };

  const record = ensureAgentAuth();
  if (!record.trial_started_at && !record.trial_consumed) {
    updateAgentAuth({ trialStartedAt: now, trialConsumed: 1 });
    state = getAuthorizationState(now);
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
  if (payload.v !== 1 || typeof payload.licenseId !== "string") throw new Error("The activation code format is invalid.");
  // The local used-license table prevents replay on this installation. The
  // device binding prevents the same signed code being copied elsewhere.
  if (typeof payload.deviceId !== "string" || !payload.deviceId.trim()) throw new Error("This activation code is not bound to a device.");
  if (payload.deviceId !== record.device_id) throw new Error("This activation code belongs to a different device.");
  if (payload.durationMs !== ACTIVATION_DURATION_MS) throw new Error("This activation code does not contain a 10-minute license.");
  if (!Array.isArray(payload.origins) || !normalizeOrigins(payload.origins).length) throw new Error("The activation code has no valid trusted website origins.");
  if (hasUsedAgentLicense(payload.licenseId) || record.activation_id === payload.licenseId) throw new Error("This activation code has already been used.");
  if (payload.issuedAt && Number(payload.issuedAt) > now + 5 * 60 * 1000) throw new Error("This activation code is not valid yet.");
  const origins = normalizeOrigins(payload.origins);
  const codeHash = createHash("sha256").update(String(code).replace(/\s+/g, "")).digest("hex");
  recordUsedAgentLicense(payload.licenseId, now);
  updateAgentAuth({
    activationId: payload.licenseId,
    activationStartedAt: now,
    activationExpiresAt: now + ACTIVATION_DURATION_MS,
    activationOriginsJson: JSON.stringify(origins),
    activationCodeHash: codeHash,
  });
  return getAuthorizationState(now);
}

export function getDeviceId() {
  return ensureAgentAuth().device_id;
}

export function getLicensePublicKeyStatus() {
  return { configured: Boolean(readPublicKey()) };
}
