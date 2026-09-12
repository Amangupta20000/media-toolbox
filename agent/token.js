import { createHash, sign, verify } from "node:crypto";

export const LICENSE_TOKEN_VERSION = 1;
export const ACTIVATION_DURATION_MS = 10 * 60 * 1000;
export const ALLOWED_ACTIVATION_DURATIONS = Object.freeze([
  { value: "10m", label: "10 minutes", durationMs: 10 * 60 * 1000 },
  { value: "30m", label: "30 minutes", durationMs: 30 * 60 * 1000 },
  { value: "2h", label: "2 hours", durationMs: 2 * 60 * 60 * 1000 },
  { value: "6h", label: "6 hours", durationMs: 6 * 60 * 60 * 1000 },
  { value: "1d", label: "1 day", durationMs: 24 * 60 * 60 * 1000 },
]);
const ALLOWED_DURATION_SET = new Set(ALLOWED_ACTIVATION_DURATIONS.map(({ durationMs }) => durationMs));

export function isAllowedActivationDuration(value) {
  return ALLOWED_DURATION_SET.has(Number(value));
}

export function activationDurationOptions() {
  return ALLOWED_ACTIVATION_DURATIONS.map(({ value, label, durationMs }) => ({ value, label, durationMs }));
}

function withoutPadding(value) {
  return Buffer.from(value).toString("base64").replace(/=+$/g, "");
}

function decodePart(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "="), "base64");
}

export function groupToken(value) {
  return String(value || "").match(/.{1,4}/g)?.join("-") || "";
}

export function normalizeLicenseToken(token) {
  const value = String(token || "").trim();
  return value.startsWith("MT1-") ? `MT1-${value.slice(4).replace(/-/g, "")}` : value;
}

export function createSignedLicenseToken(payload, privateKey) {
  const normalized = {
    v: LICENSE_TOKEN_VERSION,
    ...payload,
  };
  const payloadText = withoutPadding(JSON.stringify(normalized));
  const signature = withoutPadding(sign(null, Buffer.from(payloadText, "utf8"), privateKey));
  return `MT1-${groupToken(`${payloadText}.${signature}`)}`;
}

export function verifyLicenseToken(token, publicKey) {
  const normalized = normalizeLicenseToken(token);
  if (!normalized.startsWith("MT1-")) throw new Error("Activation codes must start with MT1-.");
  const compact = normalized.slice(4);
  const separator = compact.indexOf(".");
  if (separator < 1 || separator === compact.length - 1) throw new Error("The activation code is incomplete.");
  const payloadText = compact.slice(0, separator);
  const signature = decodePart(compact.slice(separator + 1));
  let payload;
  try {
    payload = JSON.parse(decodePart(payloadText).toString("utf8"));
  } catch {
    throw new Error("The activation code payload is invalid.");
  }
  let valid = false;
  try {
    valid = verify(null, Buffer.from(payloadText, "utf8"), publicKey, signature);
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("The activation code signature is invalid.");
  return payload;
}

export function licenseCodeHash(token) {
  return createHash("sha256").update(normalizeLicenseToken(token), "utf8").digest("hex");
}
