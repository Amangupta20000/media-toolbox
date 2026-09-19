import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyMockRequest, MOCK_API_LIMITS, MockApiError, normalizeMockProject, parseMockCurl } from "../lib/mock-api.js";
import { deleteMockProject, getMockProject, listMockProjects, saveMockProject } from "../lib/mock-api-storage.js";

const project = () => normalizeMockProject({ id: "test-api", name: "Test API", collections: [{ name: "users", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], records: [{ id: "1", name: "Ada", role: "admin" }] }] });

test("mock API CRUD engine implements collection and record semantics", () => {
  let value = project();
  let result = applyMockRequest(value, { method: "GET", pathname: "/users" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, [{ id: "1", name: "Ada", role: "admin" }]);
  result = applyMockRequest(value, { method: "POST", pathname: "/users", body: { id: "2", name: "Grace" } });
  assert.equal(result.status, 201);
  assert.equal(result.body.id, "2");
  value = result.project;
  result = applyMockRequest(value, { method: "PUT", pathname: `/users/${result.body.id}`, body: { name: "Grace Hopper", active: true } });
  assert.deepEqual(result.body, { id: result.body.id, name: "Grace Hopper", active: true });
  value = result.project;
  result = applyMockRequest(value, { method: "PATCH", pathname: `/users/${result.body.id}`, body: { role: "engineer" } });
  assert.equal(result.body.name, "Grace Hopper");
  assert.equal(result.body.role, "engineer");
  value = result.project;
  result = applyMockRequest(value, { method: "DELETE", pathname: `/users/${result.body.id}` });
  assert.equal(result.status, 204);
  assert.throws(() => applyMockRequest(result.project, { method: "GET", pathname: "/users/does-not-exist" }), (error) => error instanceof MockApiError && error.status === 404);
});

test("mock API engine returns 400, 405, and OPTIONS responses", () => {
  const value = normalizeMockProject({ id: "rules", name: "Rules", collections: [{ name: "items", methods: ["GET", "POST"], records: [] }] });
  assert.throws(() => applyMockRequest(value, { method: "POST", pathname: "/items", body: "not an object" }), (error) => error instanceof MockApiError && error.status === 400);
  assert.throws(() => applyMockRequest(value, { method: "DELETE", pathname: "/items/1" }), (error) => error instanceof MockApiError && error.status === 405 && error.headers.Allow.includes("GET"));
  const options = applyMockRequest(value, { method: "OPTIONS", pathname: "/items" });
  assert.equal(options.status, 204);
  assert.match(options.headers.Allow, /GET/);
});

test("mock API validation enforces identifiers, records, and manifest limits", () => {
  assert.throws(() => normalizeMockProject({ id: "../escape", name: "Unsafe", collections: [] }), /Project IDs/);
  assert.throws(() => normalizeMockProject({ id: "unsafe", name: "Unsafe", collections: [{ name: "__proto__", methods: ["GET"], records: [] }] }), /invalid name/);
  const tooMany = Array.from({ length: MOCK_API_LIMITS.maxRecordsPerCollection + 1 }, (_, index) => ({ id: String(index) }));
  assert.throws(() => normalizeMockProject({ id: "large", name: "Large", collections: [{ name: "items", methods: ["GET"], records: tooMany }] }), /at most 1000 records/);
  assert.throws(() => normalizeMockProject({ id: "unsafe", name: "Unsafe", collections: [{ name: "items", methods: ["GET"], records: [JSON.parse('{"__proto__":"bad"}')] }] }), /not allowed/);
});

test("mock API preserves seed records without IDs and requires IDs for new records", () => {
  const value = normalizeMockProject({ id: "no-auto-ids", name: "No automatic IDs", collections: [{ name: "users", methods: ["GET", "POST"], records: [{ name: "Ada" }, { name: "Grace" }] }] });
  assert.deepEqual(value.collections[0].records, [{ name: "Ada" }, { name: "Grace" }]);
  assert.deepEqual(applyMockRequest(value, { method: "GET", pathname: "/users" }).body, [{ name: "Ada" }, { name: "Grace" }]);
  assert.throws(() => applyMockRequest(value, { method: "POST", pathname: "/users", body: { name: "Alan" } }), (error) => error instanceof MockApiError && error.code === "missing_record_id" && error.status === 400);
});

test("mock API preserves an object-shaped database GET response", () => {
  const value = normalizeMockProject({
    id: "object-config",
    name: "Object config",
    endpoints: [{ id: "config-get", mode: "database", collection: "config", method: "GET", path: "/config" }],
    collections: [{ name: "config", methods: ["GET"], responseShape: "object", records: { enabled: true, region: "eu" } }],
  });
  assert.deepEqual(value.collections[0].records, [{ enabled: true, region: "eu" }]);
  assert.deepEqual(applyMockRequest(value, { method: "GET", pathname: "/config" }).body, { enabled: true, region: "eu" });
});

test("mock API infers object responses from raw object configs and endpoint metadata", () => {
  const rawObject = normalizeMockProject({
    id: "raw-object-config",
    name: "Raw object config",
    collections: [{ name: "config", methods: ["GET"], records: { enabled: true } }],
  });
  assert.equal(rawObject.collections[0].responseShape, "object");
  assert.deepEqual(applyMockRequest(rawObject, { method: "GET", pathname: "/config" }).body, { enabled: true });

  const endpointObject = normalizeMockProject({
    id: "endpoint-object-config",
    name: "Endpoint object config",
    endpoints: [{ id: "config-get", mode: "database", collection: "config", responseShape: "object", method: "GET", path: "/config" }],
    collections: [{ name: "config", methods: ["GET"], records: [{ enabled: true }] }],
  });
  assert.equal(endpointObject.collections[0].responseShape, "object");
  assert.deepEqual(applyMockRequest(endpointObject, { method: "GET", pathname: "/config" }).body, { enabled: true });
});

test("mock API migrates only legacy generated record IDs", () => {
  const value = normalizeMockProject({
    version: 2,
    id: "legacy-ids",
    name: "Legacy IDs",
    collections: [{ name: "users", methods: ["GET"], records: [
      { id: "users-1", name: "Ada" },
      { id: "external-42", name: "Grace" },
    ] }],
  });
  assert.equal(value.version, 3);
  assert.deepEqual(value.collections[0].records, [
    { name: "Ada" },
    { id: "external-42", name: "Grace" },
  ]);
});

test("mock API filesystem storage persists and deletes projects in Results", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-mock-api-"));
  try {
    const saved = await saveMockProject(project(), { root });
    assert.equal((await listMockProjects(root)).length, 1);
    assert.equal((await getMockProject(saved.id, root)).name, "Test API");
    await deleteMockProject(saved.id, root);
    assert.deepEqual(await listMockProjects(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("mock API supports stateless fixed responses and error scenarios", () => {
  const value = normalizeMockProject({
    id: "status-api",
    name: "Status API",
    mode: "stateless",
    endpoints: [{
      id: "health-get",
      name: "Health check",
      method: "GET",
      path: "/health",
      responses: {
        success: { status: 200, headers: { "X-Mock": "yes" }, body: { ok: true } },
        error: { status: 503, body: { ok: false, error: "offline" } },
      },
    }],
  });
  const success = applyMockRequest(value, { method: "GET", pathname: "/health" });
  assert.equal(success.status, 200);
  assert.deepEqual(success.body, { ok: true });
  assert.equal(success.headers["X-Mock"], "yes");
  const failure = applyMockRequest(value, { method: "GET", pathname: "/health", headers: { "X-Mock-Scenario": "error" } });
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, { ok: false, error: "offline" });
  assert.throws(() => applyMockRequest(value, { method: "POST", pathname: "/health" }), (error) => error instanceof MockApiError && error.status === 405 && error.headers.Allow.includes("GET"));
});

test("mock API supports multiple database APIs in one project", () => {
  const value = normalizeMockProject({
    id: "users-api",
    name: "Users API",
    mode: "database",
    collections: [{ name: "users", methods: ["GET", "POST"], records: [{ id: "1", name: "Ada" }] }],
    endpoints: [
      { id: "users-list", mode: "database", collection: "users", method: "GET", path: "/users" },
      { id: "users-create", mode: "database", collection: "users", method: "POST", path: "/users" },
    ],
  });
  assert.equal(applyMockRequest(value, { method: "GET", pathname: "/users" }).body.length, 1);
  const created = applyMockRequest(value, { method: "POST", pathname: "/users", body: { id: "2", name: "Grace" } });
  assert.equal(created.status, 201);
  assert.equal(created.project.collections[0].records.length, 2);
});

test("database endpoints keep working when their public route is renamed", () => {
  const value = normalizeMockProject({
    id: "renamed-route",
    name: "Renamed route",
    mode: "database",
    collections: [{ name: "users", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], records: [{ id: "1", name: "Ada" }] }],
    endpoints: [{ id: "users-get", name: "People", mode: "database", collection: "users", method: "GET", path: "/people" }],
  });
  const result = applyMockRequest(value, { method: "GET", pathname: "/people" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, [{ id: "1", name: "Ada" }]);
});

test("renaming a database GET route keeps records created by POST", () => {
  const value = normalizeMockProject({
    id: "renamed-after-post",
    name: "Renamed after POST",
    mode: "database",
    collections: [{ name: "users", methods: ["GET", "POST"], records: [{ id: "1", name: "Ada" }] }],
    endpoints: [
      { id: "users-get", name: "Users", mode: "database", collection: "users", method: "GET", path: "/users" },
      { id: "users-post", name: "Create user", mode: "database", collection: "users", method: "POST", path: "/users" },
    ],
  });
  const created = applyMockRequest(value, { method: "POST", pathname: "/users", body: { id: "2", name: "Grace" } });
  const renamed = normalizeMockProject({
    ...created.project,
    endpoints: created.project.endpoints.map((endpoint) => endpoint.id === "users-get" ? { ...endpoint, path: "/myapi" } : endpoint),
  });
  assert.deepEqual(applyMockRequest(renamed, { method: "GET", pathname: "/myapi" }).body, [
    { id: "1", name: "Ada" },
    { id: "2", name: "Grace" },
  ]);
});

test("mock API parses cURL locally and redacts sensitive headers", () => {
  const parsed = parseMockCurl("curl -X POST 'https://api.example.test/users?draft=1' -H 'Content-Type: application/json' -H 'Authorization: Bearer secret-value' -d '{\"name\":\"Ada\"}'");
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.path, "/users?draft=1");
  assert.equal(parsed.headers["Content-Type"], "application/json");
  assert.equal(parsed.headers.Authorization, "[redacted]");
  assert.equal(parsed.bodyText, '{"name":"Ada"}');
  assert.equal(parsed.redacted, true);
});

test("mock API parses standard multiline cURL line continuations", () => {
  const command = [
    "curl --location 'http://localhost:8890/sso/api/v1/consent/submit-user-consent'",
    "--header 'Content-Type: application/json'",
    "--header 'application_name: Live Hindustan App'",
    "--header 'clientId: 1234567'",
    "--data-raw '{\"purpose_ids\":[\"purpose-1\"],\"identifiers\":[{\"type\":\"email\",\"value\":\"user@example.com\",\"is_primary\":true}]}'",
  ].join(" \\\n");
  const parsed = parseMockCurl(command);
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.path, "/sso/api/v1/consent/submit-user-consent");
  assert.equal(parsed.headers.application_name, "Live Hindustan App");
  assert.match(parsed.bodyText, /purpose_ids/);
});

test("legacy collection projects normalize without losing CRUD behavior", () => {
  const value = normalizeMockProject({ id: "legacy", name: "Legacy", collections: [{ name: "items", methods: ["GET"], records: [] }] });
  assert.equal(value.version, 3);
  assert.equal(value.mode, "database");
  assert.deepEqual(value.endpoints, []);
  assert.equal(applyMockRequest(value, { method: "GET", pathname: "/items" }).status, 200);
});
