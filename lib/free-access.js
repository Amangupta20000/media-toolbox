export const FREE_ACCESS_CODE = "FreeForAll";
export const FREE_ACCESS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
export const FREE_ACCESS_CODE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const FREE_ACCESS_REDEMPTION_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
export const FREE_ACCESS_ISSUED_AT_SETTING = "free_access_issued_at";

export function isFreeAccessCode(value) {
  return String(value || "").trim().toLowerCase() === FREE_ACCESS_CODE.toLowerCase();
}

export function hasActiveAuthorizedLicense(localAgentStatus, now = Date.now()) {
  const authorization = localAgentStatus?.authorization || localAgentStatus?.health?.authorization;
  if (!localAgentStatus?.connected || !authorization?.authorized) return false;
  if (authorization.mode === "admin") return true;
  if (authorization.mode !== "activation") return false;
  const expiresAt = Number(authorization.expiresAt || 0);
  return !expiresAt || expiresAt > now;
}
