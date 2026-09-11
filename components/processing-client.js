const DEFAULT_AGENT_URL = "http://127.0.0.1:4789";
const TOKEN_KEY = "media-toolbox-agent-token";
const TOKEN_EXPIRY_KEY = "media-toolbox-agent-token-expires";

export function agentBaseUrl() {
  return String(process.env.NEXT_PUBLIC_AGENT_URL || DEFAULT_AGENT_URL).replace(/\/$/, "");
}

function storedAgentToken() {
  if (typeof window === "undefined") return "";
  const token = window.localStorage.getItem(TOKEN_KEY) || "";
  const expires = Number(window.localStorage.getItem(TOKEN_EXPIRY_KEY) || 0);
  if (!token || (expires && expires < Date.now())) {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(TOKEN_EXPIRY_KEY);
    return "";
  }
  return token;
}

export function clearAgentPairing() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(TOKEN_EXPIRY_KEY);
}

export function localAgentToken() {
  return storedAgentToken();
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { cache: "no-store", ...options, signal: controller.signal });
    let payload = {};
    try { payload = await response.json(); } catch { /* non-JSON response */ }
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("The request timed out. Check that the local agent is running.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeLocalAgent() {
  const base = agentBaseUrl();
  const health = await fetchJson(`${base}/v1/health`);
  const token = storedAgentToken();
  if (!token) return { available: true, connected: false, health, capabilities: null, baseUrl: base };
  try {
    const capabilities = await fetchJson(`${base}/v1/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
    return { available: true, connected: true, health, capabilities, baseUrl: base };
  } catch {
    clearAgentPairing();
    return { available: true, connected: false, health, capabilities: null, baseUrl: base };
  }
}

export async function probeServer() {
  const health = await fetchJson("/api/health");
  const capabilities = await fetchJson("/api/capabilities");
  return { available: true, connected: true, health, capabilities, baseUrl: "" };
}

export async function probeProcessingLocations() {
  const [local, server] = await Promise.allSettled([probeLocalAgent(), probeServer()]);
  return {
    local: local.status === "fulfilled" ? local.value : { available: false, connected: false, error: local.reason?.message || "Local agent is not running." },
    server: server.status === "fulfilled" ? server.value : { available: false, connected: false, error: server.reason?.message || "Server processing is unavailable." },
  };
}

export async function pairLocalAgent(code) {
  const value = await fetchJson(`${agentBaseUrl()}/v1/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: String(code || "").trim(), origin: window.location.origin }),
  });
  window.localStorage.setItem(TOKEN_KEY, value.token);
  window.localStorage.setItem(TOKEN_EXPIRY_KEY, String(value.expiresAt || Date.now() + 12 * 60 * 60 * 1000));
  return probeLocalAgent();
}

function requestOptions(mode, options = {}) {
  if (mode !== "local") return options;
  const token = storedAgentToken();
  return { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } };
}

function endpoint(mode, path) {
  return mode === "local" ? `${agentBaseUrl()}/v1${path}` : `/api${path}`;
}

export function uploadWithProgress(form, mode, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint(mode, "/jobs"));
    if (mode === "local") xhr.setRequestHeader("Authorization", `Bearer ${storedAgentToken()}`);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100)); };
    xhr.onerror = () => reject(new Error(mode === "local" ? "The local agent could not be reached. Start it and pair this browser first." : "The upload could not reach the server."));
    xhr.onload = () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText); } catch { /* no-op */ }
      if (xhr.status >= 200 && xhr.status < 300 && payload.jobId) resolve(payload);
      else reject(new Error(payload.error || (xhr.status === 401 ? "Pair this browser with the local agent first." : "The upload failed.")));
    };
    xhr.send(form);
  });
}

export async function getProcessingJob(mode, id) {
  return fetchJson(endpoint(mode, `/jobs/${encodeURIComponent(id)}`), requestOptions(mode));
}

export async function deleteProcessingJob(mode, id) {
  return fetchJson(endpoint(mode, `/jobs/${encodeURIComponent(id)}`), requestOptions(mode, { method: "DELETE" }));
}

export function processingCapabilities(locations, mode) {
  return locations?.[mode]?.capabilities || null;
}

export function isProcessingLocationReady(locations, mode) {
  return Boolean(locations?.[mode]?.connected);
}

export function resultUrlForMode(mode, result, kind = "download") {
  if (!result) return "";
  if (kind === "download") return result.downloadUrl || "";
  return result.previewUrl || (result.downloadUrl ? `${result.downloadUrl}${result.downloadUrl.includes("?") ? "&" : "?"}preview=1` : "");
}
