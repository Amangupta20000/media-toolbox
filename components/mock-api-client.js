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

export function localMockApiUrl(projectId, pathname = "/users", baseUrl = agentBaseUrl()) {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${String(baseUrl).replace(/\/$/, "")}/v1/mock/${encodeURIComponent(projectId)}${path}`;
}

export function mockFetchExample(projectId, { method = "GET", pathname = "/users", body = "", headers = {} } = {}) {
  const url = localMockApiUrl(projectId, pathname);
  const headerLine = Object.keys(headers).length ? `,\n  headers: ${JSON.stringify(headers, null, 2)}` : "";
  const fetchBody = body && method !== "GET" && method !== "DELETE" ? `,\n  body: ${JSON.stringify(body)}` : "";
  return `fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)}${headerLine}${fetchBody}\n}).then((response) => response.status === 204 ? null : response.json())`;
}

export function mockCurlExample(projectId, { method = "GET", pathname = "/users", body = "", headers = {} } = {}) {
  const url = localMockApiUrl(projectId, pathname);
  const headerPart = Object.entries(headers).map(([key, value]) => ` -H ${JSON.stringify(`${key}: ${value}`)}`).join("");
  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
  const bodyPart = body && method !== "GET" && method !== "DELETE" ? `${hasContentType ? "" : " -H 'Content-Type: application/json'"} -d '${body.replaceAll("'", "'\\''")}'` : "";
  return `curl -i -X ${method} ${JSON.stringify(url)}${headerPart}${bodyPart}`;
}
