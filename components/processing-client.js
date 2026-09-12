const DEFAULT_AGENT_URL = "http://127.0.0.1:4789";
const SECURE_AGENT_URL = "https://127.0.0.1:4789";
const TOKEN_KEY = "media-toolbox-agent-token";
const TOKEN_EXPIRY_KEY = "media-toolbox-agent-token-expires";
const SESSION_ID_KEY = "media-toolbox-agent-session-id";
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
  // content). The Electron agent uses HTTPS on the same loopback port. Local
  // HTTP development may use the lightweight HTTP agent, but must also be
  // able to reach an installed Electron agent, which is HTTPS-only.
  if (isSecurePage() && (!configured || configured.startsWith("http://"))) return SECURE_AGENT_URL;
  return configured || DEFAULT_AGENT_URL;
}

function isLoopbackAgentBase(value) {
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function agentBaseCandidates({ secure = isSecurePage(), configured = configuredAgentBaseUrl(), remembered = typeof window !== "undefined" ? window.localStorage.getItem(AGENT_BASE_KEY) : "" } = {}) {
  const candidates = secure
    ? [remembered?.startsWith("https://") ? remembered : "", configured]
    : [remembered, configured];

  // The packaged desktop agent uses HTTPS so production HTTPS pages do not
  // trigger mixed-content blocking. Keep HTTP as the first local-development
  // candidate for `npm run agent:dev`, then try the secure loopback endpoint
  // used by the installed Electron agent on the same port.
  for (const base of [...candidates]) {
    if (!base || !isLoopbackAgentBase(base)) continue;
    try {
      const parsed = new URL(base);
      const hostVariants = [base];
      if (parsed.hostname === "127.0.0.1") hostVariants.push(base.replace("127.0.0.1", "localhost"));
      if (parsed.hostname === "localhost") hostVariants.push(base.replace("localhost", "127.0.0.1"));
      for (const variant of hostVariants) {
        candidates.push(variant);
        if (!secure && parsed.protocol === "http:") candidates.push(variant.replace(/^http:/, "https:"));
      }
    } catch {
      // Ignore malformed remembered/configured values; fetchLocalJson will
      // report the normal local-agent connection error.
    }
  }
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
    window.localStorage.removeItem(SESSION_ID_KEY);
    return "";
  }
  return token;
}

export function clearAgentPairing() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(TOKEN_EXPIRY_KEY);
  window.localStorage.removeItem(SESSION_ID_KEY);
  window.localStorage.removeItem("media-toolbox-agent-auto-pair-suppressed");
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
      error.code = payload.code || "";
      error.authorization = payload.authorization;
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

function browserSessionLabel() {
  if (typeof navigator === "undefined") return "Website session";
  const userAgent = navigator.userAgent || "";
  const browser = /Edg\//.test(userAgent)
    ? "Microsoft Edge"
    : /Chrome\//.test(userAgent) && !/Chromium\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)
          ? "Safari"
          : "Browser";
  const platform = navigator.userAgentData?.platform || navigator.platform || "device";
  return `${browser} on ${String(platform).replace(/\s+/g, " ").trim()}`.slice(0, 80);
}

function storeAgentSession(value) {
  if (typeof window === "undefined" || !value?.token) return;
  window.localStorage.setItem(TOKEN_KEY, value.token);
  window.localStorage.setItem(TOKEN_EXPIRY_KEY, String(value.expiresAt || Date.now() + 12 * 60 * 60 * 1000));
  if (value.sessionId) window.localStorage.setItem(SESSION_ID_KEY, value.sessionId);
}

export async function ensureLocalAgentSession() {
  const token = storedAgentToken();
  if (token) return token;
  const { payload: session } = await fetchLocalJson("/v1/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ origin: window.location.origin, clientLabel: browserSessionLabel() }),
  });
  storeAgentSession(session);
  return storedAgentToken();
}

export async function probeLocalAgent() {
  const { payload: health, base } = await fetchLocalJson("/v1/health");
  let token = storedAgentToken();
  const readyWithoutSession = Boolean(health.processingAvailable || health.trialAvailable);
  // A new browser/profile has no token yet. Once the agent has already been
  // authorized for this trusted origin, create that browser's short-lived
  // session during discovery so Local mode is immediately usable. Do not do
  // this for a fresh trial: its five-minute clock must start only when the
  // user begins processing, not while the website is merely checking status.
  if (!token && health.processingAvailable && health.trustedOrigin) {
    try {
      token = await ensureLocalAgentSession();
    } catch (error) {
      return { available: true, connected: false, ready: readyWithoutSession, health, capabilities: null, authorization: error?.authorization || health?.authorization, baseUrl: base, error: error?.message || "The local agent browser session could not be created." };
    }
  }
  if (!token) return { available: true, connected: false, ready: readyWithoutSession, health, capabilities: null, authorization: health?.authorization, baseUrl: base };
  try {
    const { payload: capabilities } = await fetchLocalJson("/v1/capabilities", { headers: { Authorization: `Bearer ${token}` } });
    return { available: true, connected: true, ready: true, health, capabilities, authorization: health?.authorization, baseUrl: base };
  } catch (error) {
    const sessionRejected = error?.status === 401 || error?.status === 402 || (error?.status === 403 && /origin is not trusted|not paired/i.test(error.message || ""));
    if (sessionRejected) {
      clearAgentPairing();
    }
    return { available: true, connected: false, ready: readyWithoutSession, health, capabilities: null, authorization: error?.authorization || health?.authorization, baseUrl: base, error: error?.message || "The local agent capabilities could not be read.", sessionRejected };
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
    body: JSON.stringify({ code: String(code || "").trim(), origin: window.location.origin, clientLabel: browserSessionLabel() }),
  });
  storeAgentSession(value);
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
  const startUpload = () => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", endpoint(mode, "/jobs"));
    if (mode === "local") xhr.setRequestHeader("Authorization", `Bearer ${storedAgentToken()}`);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100)); };
    xhr.onerror = () => reject(new Error(mode === "local" ? "The local agent could not be reached or is not authorized. Open the Local agent dashboard." : "The upload could not reach the server."));
    xhr.onload = () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText); } catch { /* no-op */ }
      if (xhr.status >= 200 && xhr.status < 300 && (payload.jobId || (Array.isArray(payload.jobIds) && payload.jobIds.length))) resolve(payload);
      else reject(new Error(payload.error || (xhr.status === 401 || xhr.status === 402 ? "Admin login or activation is required in the Local agent dashboard." : "The upload failed.")));
    };
    xhr.send(form);
  });
  return (async () => {
    if (mode === "local") await ensureLocalAgentSession();
    return startUpload();
  })();
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

export async function getLocalSessions() {
  return fetchJson(`${agentBaseUrl()}/v1/sessions`, requestOptions("local"));
}

export async function endLocalSession(sessionId) {
  const value = await fetchJson(`${agentBaseUrl()}/v1/sessions/${encodeURIComponent(sessionId)}`, requestOptions("local", { method: "DELETE" }));
  if (value.current) {
    clearAgentPairing();
  }
  return value;
}

export async function endAllLocalSessions() {
  const value = await fetchJson(`${agentBaseUrl()}/v1/sessions/revoke-all`, requestOptions("local", { method: "POST" }));
  clearAgentPairing();
  return value;
}

export async function deleteLocalHistory(id) {
  return fetchJson(`${agentBaseUrl()}/v1/history/${encodeURIComponent(id)}`, requestOptions("local", { method: "DELETE" }));
}

export async function openLocalResultsFolder() {
  await ensureLocalAgentSession();
  return fetchJson(`${agentBaseUrl()}/v1/results/open`, requestOptions("local", { method: "POST" }));
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
  return Boolean(locations?.[mode]?.connected || locations?.[mode]?.ready);
}

export function resultUrlForMode(mode, result, kind = "download") {
  if (!result) return "";
  if (kind === "download") return result.downloadUrl || "";
  return result.previewUrl || (result.downloadUrl ? `${result.downloadUrl}${result.downloadUrl.includes("?") ? "&" : "?"}preview=1` : "");
}
