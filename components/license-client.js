const LICENSE_SERVER_URL = String(process.env.NEXT_PUBLIC_LICENSE_SERVER_URL || "").replace(/\/$/, "");
const LOCAL_LICENSE_SERVER_URL = "http://127.0.0.1:4900";
const ADMIN_TOKEN_KEY = "media-toolbox-license-admin-token";

export function licenseServerUrl() {
  return LICENSE_SERVER_URL;
}

async function licenseFetch(path, options = {}) {
  const localDevelopment = typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const urls = [...new Set([...(localDevelopment ? [LOCAL_LICENSE_SERVER_URL] : []), LICENSE_SERVER_URL].filter(Boolean))];
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

export function storedAdminToken() {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

export function storeAdminToken(token) {
  if (typeof window !== "undefined") window.sessionStorage.setItem(ADMIN_TOKEN_KEY, String(token || ""));
}

export function clearAdminToken() {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(ADMIN_TOKEN_KEY);
}

export function createLicenseRequest({ origin, requesterLabel } = {}) {
  return licenseFetch("/v1/license-requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin, requesterLabel }) });
}

export function getLicenseRequest(requestId, requestToken) {
  return licenseFetch(`/v1/license-requests/${encodeURIComponent(requestId)}`, { headers: { "X-Request-Token": String(requestToken || "") } });
}

export function loginLicenseAdmin(username, password) {
  return licenseFetch("/v1/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) }).then((value) => { storeAdminToken(value.token); return value; });
}

function adminOptions(options = {}) {
  const token = storedAdminToken();
  return { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } };
}

export function getAdminLicenseRequests() {
  return licenseFetch("/v1/admin/license-requests", adminOptions());
}

export function approveLicenseRequest(id) {
  return licenseFetch(`/v1/admin/license-requests/${encodeURIComponent(id)}/approve`, adminOptions({ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
}

export function declineLicenseRequest(id, reason = "Declined by owner") {
  return licenseFetch(`/v1/admin/license-requests/${encodeURIComponent(id)}/decline`, adminOptions({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) }));
}

export function logoutLicenseAdmin() {
  return licenseFetch("/v1/admin/logout", adminOptions({ method: "POST" })).finally(clearAdminToken);
}

export function updateGithubAgentLicenseServerUrl(url) {
  return licenseFetch("/v1/admin/github/agent-license-server-url", adminOptions({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }));
}
