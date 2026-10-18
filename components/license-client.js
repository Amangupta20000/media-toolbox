const LICENSE_SERVER_URL = String(process.env.NEXT_PUBLIC_LICENSE_SERVER_URL || "").replace(/\/$/, "");
const LOCAL_LICENSE_SERVER_URL = "http://127.0.0.1:4900";
const LICENSE_PROXY_URL = "/api/license";
const LOCAL_ADMIN_SESSION_URL = "/api/admin/session";
const ADMIN_TOKEN_KEY = "media-toolbox-license-admin-token";
const ADMIN_TOKEN_EXPIRES_KEY = "media-toolbox-license-admin-token-expires-at";
const ADMIN_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

export function licenseServerUrl() {
  return LICENSE_SERVER_URL;
}

async function licenseFetch(path, options = {}) {
  const localDevelopment = typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname);
  // Keep local development fast, but use the same-origin proxy before the
  // direct Funnel URL in deployed browsers. This avoids browser-specific
  // Tailscale/DNS/CORS failures while keeping the direct URL as a fallback.
  const urls = [...new Set([...(localDevelopment ? [LOCAL_LICENSE_SERVER_URL] : []), ...(LICENSE_SERVER_URL ? [LICENSE_PROXY_URL] : []), LICENSE_SERVER_URL].filter(Boolean))];
  if (!urls.length) throw new Error("The licensing server is not configured for this website.");
  let lastError;
  for (const baseUrl of urls) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${baseUrl}${path}`, { cache: "no-store", ...options, signal: controller.signal });
      let body = {};
      try { body = await response.json(); } catch { /* the status still explains the failure */ }
      if (!response.ok) {
        const error = new Error(body.error || `License server request failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error("The licensing server request timed out.") : error;
    } finally {
      window.clearTimeout(timeout);
    }
  }
  throw lastError || new Error("The licensing server request failed.");
}

async function localAdminFetch(options = {}) {
  const response = await fetch(LOCAL_ADMIN_SESSION_URL, { cache: "no-store", ...options });
  let body = {};
  try { body = await response.json(); } catch { /* the status still explains the failure */ }
  if (!response.ok) {
    const error = new Error(body.error || `Admin session request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function isLicenseServiceUnavailable(error) {
  return [502, 503, 504].includes(Number(error?.status)) || /not configured|could not be reached|timed out|request failed|fetch failed|failed to fetch|network/i.test(String(error?.message || ""));
}

export function storedAdminToken() {
  if (typeof window === "undefined") return "";
  let sharedToken = "";
  let canMigrateSessionToken = false;
  try {
    const stored = window.localStorage.getItem(ADMIN_TOKEN_KEY) || "";
    const expiresAt = Number(window.localStorage.getItem(ADMIN_TOKEN_EXPIRES_KEY));
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now()) {
      window.localStorage.removeItem(ADMIN_TOKEN_KEY);
      // Keep the expired timestamp as a tombstone so an older sessionStorage
      // copy cannot immediately re-promote the same expired token.
      window.localStorage.setItem(ADMIN_TOKEN_EXPIRES_KEY, String(expiresAt));
    } else {
      sharedToken = stored;
      canMigrateSessionToken = !stored;
    }
  } catch {
    // Some privacy modes deny localStorage. The per-tab session remains a
    // useful fallback for the tab that performed the login.
  }
  let sessionToken = "";
  try {
    sessionToken = window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
  } catch {
    // The shared copy is still usable when sessionStorage is unavailable.
  }
  // Migrate a token created by an older build so an already-authenticated
  // admin tab can immediately share access with the audio tab.
  if (!sharedToken && sessionToken && canMigrateSessionToken) {
    try {
      window.localStorage.setItem(ADMIN_TOKEN_KEY, sessionToken);
      window.localStorage.setItem(ADMIN_TOKEN_EXPIRES_KEY, String(Date.now() + ADMIN_TOKEN_TTL_MS));
    } catch {
      // Continue with the per-tab token if shared storage is unavailable.
    }
  }
  return sharedToken || sessionToken;
}

export function storeAdminToken(token, expiresAt = 0) {
  if (typeof window !== "undefined") {
    const value = String(token || "");
    try {
      if (value) {
        window.localStorage.setItem(ADMIN_TOKEN_KEY, value);
        const expiry = Number(expiresAt);
        if (Number.isFinite(expiry) && expiry > 0) window.localStorage.setItem(ADMIN_TOKEN_EXPIRES_KEY, String(expiry));
        else window.localStorage.removeItem(ADMIN_TOKEN_EXPIRES_KEY);
      } else {
        window.localStorage.removeItem(ADMIN_TOKEN_KEY);
        window.localStorage.removeItem(ADMIN_TOKEN_EXPIRES_KEY);
      }
    } catch {
      // Keep the session-storage copy when shared storage is unavailable.
    }
    try {
      if (value) window.sessionStorage.setItem(ADMIN_TOKEN_KEY, value);
      else window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    } catch {
      // The auth event still lets an already-open page refresh its state.
    }
    window.dispatchEvent(new CustomEvent("media-toolbox-admin-auth", { detail: { authenticated: Boolean(token) } }));
  }
}

export function clearAdminToken() {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(ADMIN_TOKEN_KEY);
      window.localStorage.removeItem(ADMIN_TOKEN_EXPIRES_KEY);
    } catch {
      // Continue clearing the per-tab copy.
    }
    try { window.sessionStorage.removeItem(ADMIN_TOKEN_KEY); } catch { /* unavailable storage is harmless */ }
    window.dispatchEvent(new CustomEvent("media-toolbox-admin-auth", { detail: { authenticated: false } }));
  }
}

export function createLicenseRequest({ origin, requesterLabel } = {}) {
  return licenseFetch("/v1/license-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin, requesterLabel }) });
}

export function getLicenseRequest(requestId, requestToken) {
  return licenseFetch(`/v1/license-requests/${encodeURIComponent(requestId)}`, { headers: { "X-Request-Token": String(requestToken || "") } });
}

export function loginLocalAdmin(username, password) {
  return localAdminFetch({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
}

export function getLocalAdminSession() {
  return localAdminFetch();
}

export function logoutLocalAdmin() {
  return localAdminFetch({ method: "DELETE" });
}

export async function loginLicenseAdmin(username, password) {
  if (!licenseServerUrl()) return { ...(await loginLocalAdmin(username, password)), offline: true };
  try {
    const value = await licenseFetch("/v1/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
    storeAdminToken(value.token, value.expiresAt);
    // Keep the same-origin gate active across reloads without exposing the
    // password or depending on the SSD service for the page shell.
    await loginLocalAdmin(username, password).catch(() => {});
    return value;
  } catch (error) {
    if (!isLicenseServiceUnavailable(error)) throw error;
    return { ...(await loginLocalAdmin(username, password)), offline: true };
  }
}

function adminOptions(options = {}) {
  const token = storedAdminToken();
  return { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } };
}

export function getAdminLicenseRequests() {
  return licenseFetch("/v1/admin/license-requests", adminOptions());
}

export function getAdminAuditLog(limit = 200) {
  const safeLimit = Math.max(1, Math.min(500, Number.parseInt(limit, 10) || 200));
  return licenseFetch(`/v1/admin/audit-log?limit=${safeLimit}`, adminOptions());
}

export function approveLicenseRequest(id) {
  return licenseFetch(`/v1/admin/license-requests/${encodeURIComponent(id)}/approve`, adminOptions({ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
}

export function declineLicenseRequest(id, reason = "Declined by owner") {
  return licenseFetch(`/v1/admin/license-requests/${encodeURIComponent(id)}/decline`, adminOptions({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) }));
}

export function logoutLicenseAdmin() {
  if (!licenseServerUrl() || !storedAdminToken()) {
    clearAdminToken();
    return Promise.resolve({ ok: true });
  }
  return licenseFetch("/v1/admin/logout", adminOptions({ method: "POST" })).finally(clearAdminToken);
}

export function updateGithubAgentLicenseServerUrl(url) {
  return licenseFetch("/v1/admin/github/agent-license-server-url", adminOptions({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }));
}
