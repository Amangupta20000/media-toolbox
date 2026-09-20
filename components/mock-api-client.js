import { applyMockRequest, formatMockProject, normalizeMockProject } from "../lib/mock-api.js";
import { agentBaseUrl, requestLocalAgentJson } from "./processing-client.js";

export function exportMockProject(value) {
  return formatMockProject(value);
}

export function importMockProject(text) { return normalizeMockProject(JSON.parse(String(text || "{}"))); }

export function simulateMockRequest(project, request) {
  return applyMockRequest(project, request);
}

export async function listLocalMockProjects() {
  const payload = await requestLocalAgentJson("/v1/mock-apis");
  if (!Array.isArray(payload?.items)) return [];
  return payload.items.map((item) => {
    try { return normalizeMockProject(item); } catch { return null; }
  }).filter(Boolean);
}

export async function saveLocalMockProject(project) {
  const normalized = normalizeMockProject(project);
  const id = normalized.id;
  const method = (await listLocalMockProjects()).some((item) => item.id === id) ? "PUT" : "POST";
  const path = method === "POST" ? "/v1/mock-apis" : `/v1/mock-apis/${encodeURIComponent(id)}`;
  const payload = await requestLocalAgentJson(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(normalized) });
  return normalizeMockProject(payload?.project || normalized);
}

export async function deleteLocalMockProject(id) {
  return requestLocalAgentJson(`/v1/mock-apis/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function requestServerMockJson(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  let payload = {};
  try { payload = await response.json(); } catch { /* Empty 204 responses are valid. */ }
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = payload.code || "";
    error.headers = Object.fromEntries(response.headers.entries());
    throw error;
  }
  return payload;
}

export async function listServerMockProjects() {
  const payload = await requestServerMockJson("/api/mock-apis");
  if (!Array.isArray(payload?.items)) return [];
  return payload.items.map((item) => {
    try { return normalizeMockProject(item); } catch { return null; }
  }).filter(Boolean);
}

export async function getServerMockProject(id) {
  const payload = await requestServerMockJson(`/api/mock-apis/${encodeURIComponent(id)}`);
  return normalizeMockProject(payload?.project || {});
}

export async function saveServerMockProject(project) {
  const normalized = normalizeMockProject(project);
  const method = (await listServerMockProjects()).some((item) => item.id === normalized.id) ? "PUT" : "POST";
  const path = method === "POST" ? "/api/mock-apis" : `/api/mock-apis/${encodeURIComponent(normalized.id)}`;
  const payload = await requestServerMockJson(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(normalized) });
  return normalizeMockProject(payload?.project || normalized);
}

export async function deleteServerMockProject(id) {
  return requestServerMockJson(`/api/mock-apis/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function serverMockApiUrl(projectId, pathname = "/users", baseUrl = "") {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${String(baseUrl || "").replace(/\/$/, "")}/api/mock/${encodeURIComponent(projectId)}${path}`;
}

export async function simulateServerMockRequest(projectId, { method = "GET", pathname = "/users", body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined && body !== null && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-type")) requestHeaders["Content-Type"] = "application/json";
  const response = await fetch(serverMockApiUrl(projectId, pathname), {
    cache: "no-store",
    method,
    headers: requestHeaders,
    body: body === undefined || body === null || ["GET", "HEAD", "OPTIONS"].includes(method) ? undefined : JSON.stringify(body),
  });
  let responseBody = null;
  try { responseBody = await response.json(); } catch { /* Empty 204 responses are valid. */ }
  const result = { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: responseBody };
  if (!response.ok) {
    const error = new Error(responseBody?.error || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = responseBody?.code || "";
    error.headers = result.headers;
    throw error;
  }
  if (!["GET", "OPTIONS"].includes(String(method).toUpperCase())) result.project = await getServerMockProject(projectId);
  return result;
}

export function localMockApiUrl(projectId, pathname = "/users", baseUrl = agentBaseUrl()) {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${String(baseUrl).replace(/\/$/, "")}/v1/mock/${encodeURIComponent(projectId)}${path}`;
}

export function mockFetchExample(projectId, { method = "GET", pathname = "/users", body = "", headers = {}, hostingMode = "local", baseUrl = "" } = {}) {
  const url = hostingMode === "server" ? serverMockApiUrl(projectId, pathname, baseUrl) : localMockApiUrl(projectId, pathname, baseUrl || undefined);
  const headerLine = Object.keys(headers).length ? `,\n  headers: ${JSON.stringify(headers, null, 2)}` : "";
  const fetchBody = body && method !== "GET" && method !== "DELETE" ? `,\n  body: ${JSON.stringify(body)}` : "";
  return `fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)}${headerLine}${fetchBody}\n}).then((response) => response.status === 204 ? null : response.json())`;
}

export function mockCurlExample(projectId, { method = "GET", pathname = "/users", body = "", headers = {}, hostingMode = "local", baseUrl = "" } = {}) {
  const url = hostingMode === "server" ? serverMockApiUrl(projectId, pathname, baseUrl) : localMockApiUrl(projectId, pathname, baseUrl || undefined);
  const headerPart = Object.entries(headers).map(([key, value]) => ` -H ${JSON.stringify(`${key}: ${value}`)}`).join("");
  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
  const bodyPart = body && method !== "GET" && method !== "DELETE" ? `${hasContentType ? "" : " -H 'Content-Type: application/json'"} -d '${body.replaceAll("'", "'\\''")}'` : "";
  return `curl -i -X ${method} ${JSON.stringify(url)}${headerPart}${bodyPart}`;
}
