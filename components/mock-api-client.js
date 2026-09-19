import { applyMockRequest, formatMockProject, normalizeMockProject } from "../lib/mock-api.js";
import { agentBaseUrl, requestLocalAgentJson } from "./processing-client.js";

const DB_NAME = "native-media-agent-mock-apis";
const STORE_NAME = "projects";
let memoryProjects = new Map();

function browserOnly() { return typeof window !== "undefined" && typeof indexedDB !== "undefined"; }

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB is unavailable."));
  });
}

async function withStore(mode, action) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("The browser project could not be stored."));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(transaction.error || new Error("The browser project could not be stored."));
  });
}

export async function listBrowserMockProjects() {
  if (!browserOnly()) return [...memoryProjects.values()];
  try { return (await withStore("readonly", (store) => store.getAll())).map(normalizeMockProject); }
  catch { return [...memoryProjects.values()]; }
}

export async function saveBrowserMockProject(value) {
  const project = normalizeMockProject(value);
  memoryProjects.set(project.id, project);
  if (!browserOnly()) return project;
  try { await withStore("readwrite", (store) => store.put(project)); } catch { /* memory fallback keeps the current tab usable */ }
  return project;
}

export async function deleteBrowserMockProject(id) {
  memoryProjects.delete(id);
  if (browserOnly()) { try { await withStore("readwrite", (store) => store.delete(id)); } catch { /* no-op */ } }
}

export function exportMockProject(value) {
  return formatMockProject(value);
}

export async function importMockProject(text) {
  const project = normalizeMockProject(JSON.parse(String(text || "{}")));
  return saveBrowserMockProject(project);
}

export function simulateMockRequest(project, request) {
  return applyMockRequest(project, request);
}

export async function listLocalMockProjects() {
  return (await requestLocalAgentJson("/v1/mock-apis")).items || [];
}

export async function saveLocalMockProject(project) {
  const normalized = normalizeMockProject(project);
  const id = normalized.id;
  const method = (await listLocalMockProjects()).some((item) => item.id === id) ? "PUT" : "POST";
  const path = method === "POST" ? "/v1/mock-apis" : `/v1/mock-apis/${encodeURIComponent(id)}`;
  const payload = await requestLocalAgentJson(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(normalized) });
  return payload.project;
}

export async function deleteLocalMockProject(id) {
  return requestLocalAgentJson(`/v1/mock-apis/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function localMockApiUrl(projectId, pathname = "/users") {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${agentBaseUrl()}/v1/mock/${encodeURIComponent(projectId)}${path}`;
}

export function mockFetchExample(projectId, { method = "GET", pathname = "/users", body = "" } = {}) {
  const url = localMockApiUrl(projectId, pathname);
  const fetchBody = body && method !== "GET" && method !== "DELETE" ? `,\n  body: ${JSON.stringify(body)}` : "";
  return `fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)}${fetchBody}\n}).then((response) => response.status === 204 ? null : response.json())`;
}

export function mockCurlExample(projectId, { method = "GET", pathname = "/users", body = "" } = {}) {
  const url = localMockApiUrl(projectId, pathname);
  const bodyPart = body && method !== "GET" && method !== "DELETE" ? ` -H 'Content-Type: application/json' -d '${body.replaceAll("'", "'\\''")}'` : "";
  return `curl -i -X ${method} ${JSON.stringify(url)}${bodyPart}`;
}
