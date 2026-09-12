const DEFAULT_AGENT_URL = "http://127.0.0.1:4789";
const SECURE_AGENT_URL = "https://127.0.0.1:4789";
const TOKEN_KEY = "media-toolbox-agent-token";
const TOKEN_EXPIRY_KEY = "media-toolbox-agent-token-expires";
const AGENT_BASE_KEY = "media-toolbox-agent-base";

export function agentBaseUrl() {
  if (typeof window !== "undefined") {
    const remembered = window.localStorage.getItem(AGENT_BASE_KEY);
    if (remembered && (!isSecurePage() || remembered.startsWith("https://"))) return remembered;
  }
  return configuredAgentBaseUrl();
}

function isSecurePage() {
  return typeof window !== "undefined" && window.location.protocol === "https:";
}

function configuredAgentBaseUrl() {
  const configured = String(process.env.NEXT_PUBLIC_AGENT_URL || "").replace(/\/$/, "");
  // HTTPS pages cannot fetch the agent's HTTP endpoint in Safari (mixed
  // content). The Electron agent uses HTTPS on the same loopback port, while
  // local HTTP development continues to use the lightweight HTTP agent.
  if (isSecurePage() && (!configured || configured.startsWith("http://"))) return SECURE_AGENT_URL;
  return configured || DEFAULT_AGENT_URL;
}

function agentBaseCandidates() {
  const configured = configuredAgentBaseUrl();
  const remembered = typeof window !== "undefined" ? window.localStorage.getItem(AGENT_BASE_KEY) : "";
  const candidates = isSecurePage()
    ? [remembered?.startsWith("https://") ? remembered : "", configured]
    : [remembered, configured];
  if (configured.includes("127.0.0.1")) candidates.push(configured.replace("127.0.0.1", "localhost"));
  if (configured.includes("localhost")) candidates.push(configured.replace("localhost", "127.0.0.1"));
  return candidates.filter((value, index) => value && candidates.indexOf(value) === index);
}

function rememberAgentBase(base) {
  if (typeof window !== "undefined" && base) window.localStorage.setItem(AGENT_BASE_KEY, base);
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
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("The request timed out. Check that the local agent is running.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLocalJson(path, options = {}) {
  let lastError;
  for (const base of agentBaseCandidates()) {
    try {
      const payload = await fetchJson(`${base}${path}`, options);
      rememberAgentBase(base);
      return { payload, base };
    } catch (error) {
      // HTTP responses are authoritative. Only try the alternate loopback
      // hostname for network-level failures such as Safari's "Load failed".
      if (error?.status) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("The local agent could not be reached.");
}

export async function probeLocalAgent() {
  const { payload: health, base } = await fetchLocalJson("/v1/health");
  const token = storedAgentToken();
  if (!health?.paired) {
    // A desktop-agent restart invalidates in-memory sessions. Do not let an
    // old token turn a normal pairing state into a generic Safari "Load
    // failed" error while probing capabilities.
    if (token) clearAgentPairing();
    return { available: true, connected: false, health, capabilities: null, baseUrl: base };
  }
  if (!token) return { available: true, connected: false, health, capabilities: null, baseUrl: base };
  try {
    const { payload: capabilities } = await fetchLocalJson("/v1/capabilities", { headers: { Authorization: `Bearer ${token}` } });
    return { available: true, connected: true, health, capabilities, baseUrl: base };
  } catch (error) {
    // Keep the token during network/startup failures. Only discard it when the
    // agent explicitly says this session is no longer authorized.
    const pairingRejected = error?.status === 401 || (error?.status === 403 && /origin is not paired|pair the website/i.test(error.message || ""));
    if (pairingRejected) clearAgentPairing();
    return { available: true, connected: false, health, capabilities: null, baseUrl: base, error: error?.message || "The local agent capabilities could not be read.", pairingRejected };
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
  const { payload: value } = await fetchLocalJson("/v1/pair", {
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

export async function getLocalHistory(tool) {
  const query = `?tool=${encodeURIComponent(tool)}`;
  return fetchJson(`${agentBaseUrl()}/v1/history${query}`, requestOptions("local"));
}

export async function deleteLocalHistory(id) {
  return fetchJson(`${agentBaseUrl()}/v1/history/${encodeURIComponent(id)}`, requestOptions("local", { method: "DELETE" }));
}

export async function deleteDownloadedFile(folderPath, filename) {
  return fetchJson(`${agentBaseUrl()}/v1/files/delete`, requestOptions("local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderPath, filename }),
  }));
}

export async function getServerHistory(tool) {
  return fetchJson(`/api/history?tool=${encodeURIComponent(tool)}`);
}

export async function deleteServerHistory(id) {
  return fetchJson(`/api/history/${encodeURIComponent(id)}`, { method: "DELETE" });
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
