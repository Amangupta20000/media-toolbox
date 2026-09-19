export const MOCK_API_VERSION = 1;
export const MOCK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const MOCK_API_LIMITS = Object.freeze({
  maxCollections: 20,
  maxRecordsPerCollection: 1000,
  maxProjectBytes: 1024 * 1024,
  maxRequestBytes: 256 * 1024,
  maxResponseBytes: 256 * 1024,
});

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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

function normalizeRecord(record, index, collectionName) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new MockApiError(`Record ${index + 1} in ${collectionName} must be a JSON object.`, 400, "invalid_record");
  validateJsonValue(record);
  const next = { ...clone(record) };
  if (next.id === undefined || next.id === null || String(next.id).trim() === "") next.id = `${collectionName}-${index + 1}`;
  next.id = String(next.id);
  if (next.id.length > 128) throw new MockApiError("Record IDs must be 128 characters or fewer.", 400, "invalid_record_id");
  return next;
}

export function isSafeMockId(value) {
  return SAFE_ID.test(String(value || ""));
}

export function normalizeMockProject(input = {}, { id: forcedId } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MockApiError("A mock API project must be a JSON object.");
  const id = String(forcedId || input.id || createId("mock"));
  if (!isSafeMockId(id)) throw new MockApiError("Project IDs may contain letters, numbers, hyphens, and underscores, and must start with a letter.", 400, "invalid_project_id");
  const name = String(input.name || "Untitled mock API").trim().slice(0, 120);
  if (!name) throw new MockApiError("Project name is required.", 400, "invalid_project_name");
  const sourceCollections = Array.isArray(input.collections) ? input.collections : [];
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
    records.forEach((record) => { if (recordIds.has(record.id)) throw new MockApiError(`The record ID ${record.id} is duplicated in ${collectionName}.`, 400, "duplicate_record_id"); recordIds.add(record.id); });
    return { name: collectionName, methods: methods.length ? methods : ["GET"], records };
  });
  const now = new Date().toISOString();
  const project = { version: MOCK_API_VERSION, id, name, createdAt: String(input.createdAt || now), updatedAt: String(input.updatedAt || now), collections };
  if (bytes(project) > MOCK_API_LIMITS.maxProjectBytes) throw new MockApiError("The mock API project is larger than 1 MB.", 413, "project_limit");
  return project;
}

function allowFor(collection) {
  return ["OPTIONS", ...collection.methods].join(", ");
}

function jsonResponse(status, body, headers = {}) {
  const response = { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers }, body: body === undefined ? null : clone(body) };
  if (body !== undefined && bytes(body) > MOCK_API_LIMITS.maxResponseBytes) throw new MockApiError("The mock API response is larger than 256 KB.", 413, "response_limit");
  return response;
}

function bodyObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MockApiError("The request body must be a JSON object.", 400, "invalid_request_body");
  validateJsonValue(body);
  return clone(body);
}

export function applyMockRequest(projectInput, { method = "GET", pathname = "/", body } = {}) {
  const project = normalizeMockProject(projectInput);
  const upperMethod = String(method).toUpperCase();
  if (!MOCK_METHODS.includes(upperMethod) && upperMethod !== "OPTIONS") throw new MockApiError("Only GET, POST, PUT, PATCH, DELETE, and OPTIONS are supported.", 405, "method_not_allowed");
  const cleanPath = String(pathname || "/").split("?", 1)[0].replace(/^\/+|\/+$/g, "");
  const segments = cleanPath ? cleanPath.split("/").map((part) => decodeURIComponent(part)) : [];
  if (segments.length < 1 || segments.length > 2) throw new MockApiError("Choose a collection and optional record ID.", 404, "not_found");
  const collection = project.collections.find((entry) => entry.name === segments[0]);
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
    record.id = String(record.id || createId(collection.name));
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

export function formatMockProject(project) {
  return JSON.stringify(normalizeMockProject(project), null, 2);
}
