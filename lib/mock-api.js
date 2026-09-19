export const MOCK_API_VERSION = 2;
export const MOCK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const MOCK_MODES = ["database", "stateless"];
export const MOCK_API_LIMITS = Object.freeze({
  maxCollections: 20,
  maxEndpoints: 50,
  maxRecordsPerCollection: 1000,
  maxProjectBytes: 1024 * 1024,
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 256 * 1024,
});

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SAFE_PATH = /^\/[A-Za-z0-9_~.%:-]*(?:\/[A-Za-z0-9_~.%:-]+)*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SENSITIVE_HEADER = /authorization|cookie|token|api[-_]?key|secret|password/i;

export class MockApiError extends Error {
  constructor(message, status = 400, code = "mock_api_error", headers = {}) {
    super(message);
    this.name = "MockApiError";
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function bytes(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return typeof TextEncoder === "undefined" ? text.length : new TextEncoder().encode(text).byteLength;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createId(prefix = "project") {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureSafeKey(key) {
  if (FORBIDDEN_KEYS.has(key)) throw new MockApiError(`The key ${key} is not allowed.`, 400, "unsafe_key");
}

function validateJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new MockApiError("Records must contain valid JSON values.", 400, "invalid_json");
    return;
  }
  if (typeof value !== "object") throw new MockApiError("Records must contain valid JSON values.", 400, "invalid_json");
  if (seen.has(value)) throw new MockApiError("Circular records are not supported.", 400, "invalid_json");
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry) => validateJsonValue(entry, seen));
  else Object.entries(value).forEach(([key, entry]) => { ensureSafeKey(key); validateJsonValue(entry, seen); });
  seen.delete(value);
}

function normalizeHeaders(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MockApiError("Headers must be a JSON object.", 400, "invalid_headers");
  const headers = {};
  Object.entries(value).forEach(([key, rawValue]) => {
    const name = String(key).trim();
    const headerValue = String(rawValue ?? "");
    if (!name || name.length > 100 || /[\r\n]/.test(name) || /[\r\n]/.test(headerValue)) throw new MockApiError("Header names and values must be valid single lines.", 400, "invalid_headers");
    headers[name] = headerValue.slice(0, 4000);
  });
  return headers;
}

function normalizePath(value) {
  const path = String(value || "/").trim();
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (!SAFE_PATH.test(normalized) || normalized.includes("..")) throw new MockApiError("API paths may contain safe URL characters and path parameters such as /users/:id.", 400, "invalid_api_path");
  return normalized === "/" ? normalized : normalized.replace(/\/$/, "");
}

function normalizeRecord(record, index, collectionName) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new MockApiError(`Record ${index + 1} in ${collectionName} must be a JSON object.`, 400, "invalid_record");
  validateJsonValue(record);
  const next = { ...clone(record) };
  if (next.id !== undefined && next.id !== null && String(next.id).trim() !== "") {
    next.id = String(next.id);
    if (next.id.length > 128) throw new MockApiError("Record IDs must be 128 characters or fewer.", 400, "invalid_record_id");
  }
  return next;
}

export function isSafeMockId(value) {
  return SAFE_ID.test(String(value || ""));
}

function normalizeResponse(value, fallback) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const status = Number(source.status ?? fallback.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) throw new MockApiError("Response status must be an HTTP status between 100 and 599.", 400, "invalid_response_status");
  const body = source.body === undefined ? clone(fallback.body) : clone(source.body);
  validateJsonValue(body);
  if (body !== undefined && bytes(body) > MOCK_API_LIMITS.maxResponseBytes) throw new MockApiError("The mock API response is larger than 256 KB.", 413, "response_limit");
  return { status, headers: normalizeHeaders(source.headers || fallback.headers || { "Content-Type": "application/json; charset=utf-8" }), body: body === undefined ? null : body, override: Boolean(source.override) };
}

function normalizeEndpoint(endpoint, index, mode) {
  const source = endpoint && typeof endpoint === "object" && !Array.isArray(endpoint) ? endpoint : {};
  const endpointMode = source.mode === "stateless" || mode === "stateless" ? "stateless" : "database";
  const method = String(source.method || "GET").toUpperCase();
  if (!MOCK_METHODS.includes(method)) throw new MockApiError(`Endpoint ${index + 1} has an unsupported method.`, 400, "invalid_method");
  const path = normalizePath(source.path || (source.collection ? `/${source.collection}` : "/api"));
  const id = String(source.id || `${method.toLowerCase()}-${index + 1}`);
  if (!isSafeMockId(id)) throw new MockApiError(`Endpoint ${index + 1} has an invalid ID.`, 400, "invalid_endpoint_id");
  const collection = source.collection === undefined ? undefined : String(source.collection).trim();
  if (endpointMode === "database" && collection && !isSafeMockId(collection)) throw new MockApiError(`Endpoint ${index + 1} has an invalid collection.`, 400, "invalid_collection_name");
  const request = source.request && typeof source.request === "object" ? source.request : {};
  const requestBody = request.body === undefined ? null : clone(request.body);
  validateJsonValue(requestBody);
  const successFallback = { status: method === "POST" ? 201 : method === "DELETE" ? 204 : 200, headers: { "Content-Type": "application/json; charset=utf-8" }, body: {} };
  const errorFallback = { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" }, body: { error: "Mock API error" } };
  return {
    id,
    name: String(source.name || `${method} ${path}`).trim().slice(0, 120) || `${method} ${path}`,
    mode: endpointMode,
    method,
    path,
    collection,
    request: { headers: normalizeHeaders(request.headers || {}), body: requestBody },
    responses: {
      success: normalizeResponse(source.responses?.success, successFallback),
      error: normalizeResponse(source.responses?.error, errorFallback),
    },
  };
}

export function normalizeMockProject(input = {}, { id: forcedId } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MockApiError("A mock API project must be a JSON object.");
  const id = String(forcedId || input.id || createId("mock"));
  if (!isSafeMockId(id)) throw new MockApiError("Project IDs may contain letters, numbers, hyphens, and underscores, and must start with a letter.", 400, "invalid_project_id");
  const name = String(input.name || "Untitled mock API").trim().slice(0, 120);
  if (!name) throw new MockApiError("Project name is required.", 400, "invalid_project_name");
  const mode = input.mode === "stateless" || input.dataMode === "stateless" ? "stateless" : "database";
  const sourceCollections = mode === "database" && Array.isArray(input.collections) ? input.collections : [];
  if (sourceCollections.length > MOCK_API_LIMITS.maxCollections) throw new MockApiError(`A project can contain at most ${MOCK_API_LIMITS.maxCollections} collections.`, 413, "collection_limit");
  const names = new Set();
  const collections = sourceCollections.map((collection, collectionIndex) => {
    const collectionName = String(collection?.name || "").trim();
    if (!isSafeMockId(collectionName)) throw new MockApiError(`Collection ${collectionIndex + 1} has an invalid name.`, 400, "invalid_collection_name");
    if (names.has(collectionName)) throw new MockApiError(`The collection ${collectionName} is duplicated.`, 400, "duplicate_collection");
    names.add(collectionName);
    const methods = [...new Set((Array.isArray(collection.methods) ? collection.methods : ["GET"]).map((method) => String(method).toUpperCase()))];
    if (!methods.every((method) => MOCK_METHODS.includes(method))) throw new MockApiError(`Collection ${collectionName} has an unsupported method.`, 400, "invalid_method");
    const sourceRecords = Array.isArray(collection.records) ? collection.records : [];
    if (sourceRecords.length > MOCK_API_LIMITS.maxRecordsPerCollection) throw new MockApiError(`Collection ${collectionName} can contain at most ${MOCK_API_LIMITS.maxRecordsPerCollection} records.`, 413, "record_limit");
    const records = sourceRecords.map((record, index) => normalizeRecord(record, index, collectionName));
    const recordIds = new Set();
    records.forEach((record) => {
      if (record.id === undefined || record.id === null || String(record.id).trim() === "") return;
      if (recordIds.has(record.id)) throw new MockApiError(`The record ID ${record.id} is duplicated in ${collectionName}.`, 400, "duplicate_record_id");
      recordIds.add(record.id);
    });
    return { name: collectionName, methods: methods.length ? methods : ["GET"], records };
  });
  const sourceEndpoints = Array.isArray(input.endpoints) ? input.endpoints : [];
  if (sourceEndpoints.length > MOCK_API_LIMITS.maxEndpoints) throw new MockApiError(`A project can contain at most ${MOCK_API_LIMITS.maxEndpoints} APIs.`, 413, "endpoint_limit");
  const endpointIds = new Set();
  const endpoints = sourceEndpoints.map((endpoint, index) => {
    const normalized = normalizeEndpoint(endpoint, index, mode);
    if (endpointIds.has(normalized.id)) throw new MockApiError(`The API ID ${normalized.id} is duplicated.`, 400, "duplicate_endpoint_id");
    endpointIds.add(normalized.id);
    if (normalized.mode === "database" && normalized.collection && !names.has(normalized.collection)) throw new MockApiError(`The API collection ${normalized.collection} does not exist.`, 400, "collection_not_found");
    return normalized;
  });
  const now = new Date().toISOString();
  const project = { version: MOCK_API_VERSION, id, name, mode, createdAt: String(input.createdAt || now), updatedAt: String(input.updatedAt || now), collections, endpoints };
  if (bytes(project) > MOCK_API_LIMITS.maxProjectBytes) throw new MockApiError("The mock API project is larger than 1 MB.", 413, "project_limit");
  return project;
}

function allowFor(collection) {
  return ["OPTIONS", ...(collection?.methods || [])].join(", ");
}

function jsonResponse(status, body, headers = {}) {
  const response = { status, headers: { "Content-Type": "application/json; charset=utf-8", ...normalizeHeaders(headers) }, body: body === undefined ? null : clone(body) };
  if (body !== undefined && bytes(body) > MOCK_API_LIMITS.maxResponseBytes) throw new MockApiError("The mock API response is larger than 256 KB.", 413, "response_limit");
  return response;
}

function bodyObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MockApiError("The request body must be a JSON object.", 400, "invalid_request_body");
  validateJsonValue(body);
  return clone(body);
}

function applyCollectionRequest(project, { method = "GET", pathname = "/", body, collectionName } = {}) {
  const upperMethod = String(method).toUpperCase();
  if (!MOCK_METHODS.includes(upperMethod) && upperMethod !== "OPTIONS") throw new MockApiError("Only GET, POST, PUT, PATCH, DELETE, and OPTIONS are supported.", 405, "method_not_allowed");
  const cleanPath = String(pathname || "/").split("?", 1)[0].replace(/^\/+|\/+$/g, "");
  const segments = cleanPath ? cleanPath.split("/").map((part) => decodeURIComponent(part)) : [];
  if (segments.length < 1 || segments.length > 2) throw new MockApiError("Choose a collection and optional record ID.", 404, "not_found");
  const collection = project.collections.find((entry) => entry.name === (collectionName || segments[0]));
  if (!collection) throw new MockApiError("Collection not found.", 404, "collection_not_found");
  const recordId = segments[1];
  if (upperMethod === "OPTIONS") return { ...jsonResponse(204, undefined, { Allow: allowFor(collection) }), project };
  if (!collection.methods.includes(upperMethod)) throw new MockApiError(`Method ${upperMethod} is disabled for ${collection.name}.`, 405, "method_not_allowed", { Allow: allowFor(collection) });
  if (upperMethod === "GET") {
    if (recordId !== undefined) {
      const record = collection.records.find((entry) => entry.id === recordId);
      if (!record) throw new MockApiError("Record not found.", 404, "not_found");
      return { ...jsonResponse(200, record), project };
    }
    return { ...jsonResponse(200, collection.records), project };
  }
  if (upperMethod === "POST") {
    if (recordId !== undefined) throw new MockApiError("POST targets a collection, not an individual record.", 404, "not_found");
    const record = bodyObject(body);
    if (record.id === undefined || record.id === null || String(record.id).trim() === "") throw new MockApiError("POST records must include an id. Automatic record IDs are disabled.", 400, "missing_record_id");
    record.id = String(record.id);
    if (collection.records.some((entry) => entry.id === record.id)) throw new MockApiError("A record with that ID already exists.", 409, "duplicate_record_id");
    if (collection.records.length >= MOCK_API_LIMITS.maxRecordsPerCollection) throw new MockApiError("This collection has reached its record limit.", 413, "record_limit");
    collection.records.push(record);
    return { ...jsonResponse(201, record), project };
  }
  if (!recordId) throw new MockApiError("This method requires a record ID.", 404, "not_found");
  const index = collection.records.findIndex((record) => record.id === recordId);
  if (index < 0) throw new MockApiError("Record not found.", 404, "not_found");
  if (upperMethod === "DELETE") { collection.records.splice(index, 1); return { ...jsonResponse(204, undefined), project }; }
  const next = bodyObject(body);
  next.id = recordId;
  collection.records[index] = upperMethod === "PATCH" ? { ...collection.records[index], ...next, id: recordId } : next;
  return { ...jsonResponse(200, collection.records[index]), project };
}

function headerValue(headers = {}, name) {
  const target = String(name).toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function routeMatches(pattern, pathname, { allowDatabaseRecord = false } = {}) {
  const expected = normalizePath(pattern).split("/").filter(Boolean);
  const actual = String(pathname || "/").split("?", 1)[0].split("/").filter(Boolean);
  if (allowDatabaseRecord && actual.length === expected.length + 1 && expected.length === 1 && actual[0] === expected[0]) return true;
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => segment.startsWith(":") || decodeURIComponent(segment) === decodeURIComponent(actual[index]));
}

function endpointAllow(project, pathname) {
  const matching = project.endpoints.filter((endpoint) => routeMatches(endpoint.path, pathname, { allowDatabaseRecord: endpoint.mode === "database" }));
  return ["OPTIONS", ...new Set(matching.map((endpoint) => endpoint.method))].join(", ");
}

function applyEndpointRequest(project, { method = "GET", pathname = "/", body, headers = {} } = {}) {
  const upperMethod = String(method).toUpperCase();
  const endpoint = project.endpoints.find((entry) => routeMatches(entry.path, pathname, { allowDatabaseRecord: entry.mode === "database" }) && entry.method === upperMethod);
  if (upperMethod === "OPTIONS") return { ...jsonResponse(204, undefined, { Allow: endpointAllow(project, pathname) }), project };
  if (!endpoint) {
    const allow = endpointAllow(project, pathname);
    if (allow !== "OPTIONS") throw new MockApiError(`Method ${upperMethod} is not configured for this API path.`, 405, "method_not_allowed", { Allow: allow });
    throw new MockApiError("API endpoint not found.", 404, "not_found");
  }
  const scenario = String(headerValue(headers, "x-mock-scenario") || "success").toLowerCase();
  if (scenario === "error") {
    const configured = endpoint.responses.error;
    return { ...jsonResponse(configured.status, configured.body, configured.headers), project };
  }
  if (endpoint.mode === "stateless") {
    const configured = endpoint.responses.success;
    return { ...jsonResponse(configured.status, configured.body, configured.headers), project };
  }
  const collectionName = endpoint.collection || String(pathname || "/").split("?", 1)[0].split("/").filter(Boolean)[0];
  const result = applyCollectionRequest(project, { method: upperMethod, pathname, body, collectionName });
  if (!endpoint.responses.success.override) return result;
  const configured = endpoint.responses.success;
  return { ...jsonResponse(configured.status, configured.body, configured.headers), project: result.project };
}

export function applyMockRequest(projectInput, request = {}) {
  const project = normalizeMockProject(projectInput);
  if (project.endpoints.length) return applyEndpointRequest(project, request);
  return applyCollectionRequest(project, request);
}

export function formatMockProject(project) {
  return JSON.stringify(normalizeMockProject(project), null, 2);
}

function shellWords(input) {
  const words = [];
  let word = "";
  let quote = "";
  let escaped = false;
  for (const character of String(input || "")) {
    if (escaped) { word += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; else word += character; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/\s/.test(character)) { if (word) { words.push(word); word = ""; } continue; }
    word += character;
  }
  if (escaped) word += "\\";
  if (quote) throw new MockApiError("The cURL command has an unterminated quote.", 400, "invalid_curl");
  if (word) words.push(word);
  return words;
}

export function parseMockCurl(input) {
  const words = shellWords(input);
  if (!words.length || !["curl", "curl.exe"].includes(words[0].toLowerCase())) throw new MockApiError("Paste a cURL command beginning with curl.", 400, "invalid_curl");
  let method = "GET";
  let bodyText = "";
  let urlText = "";
  const headers = {};
  let redacted = false;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === "-X" || word === "--request") { method = String(words[++index] || "").toUpperCase(); continue; }
    if (word === "-H" || word === "--header") {
      const raw = words[++index] || "";
      const separator = raw.indexOf(":");
      if (separator < 1) throw new MockApiError("Each cURL header must use Name: value format.", 400, "invalid_curl");
      const name = raw.slice(0, separator).trim();
      let value = raw.slice(separator + 1).trim();
      if (SENSITIVE_HEADER.test(name)) { value = "[redacted]"; redacted = true; }
      headers[name] = value;
      continue;
    }
    if (["-d", "--data", "--data-raw", "--data-binary"].includes(word)) { bodyText = words[++index] || ""; if (method === "GET") method = "POST"; continue; }
    if (word === "--url") { urlText = words[++index] || ""; continue; }
    if (!word.startsWith("-")) urlText = word;
  }
  if (!MOCK_METHODS.includes(method)) throw new MockApiError("The cURL method must be GET, POST, PUT, PATCH, or DELETE.", 400, "invalid_curl");
  if (!urlText) throw new MockApiError("The cURL command does not contain a URL.", 400, "invalid_curl");
  let parsed;
  try { parsed = new URL(urlText); } catch { throw new MockApiError("The cURL URL is invalid.", 400, "invalid_curl"); }
  return { method, path: `${parsed.pathname}${parsed.search}`, headers, bodyText, redacted };
}

export function isSensitiveMockHeader(name) {
  return SENSITIVE_HEADER.test(String(name || ""));
}
