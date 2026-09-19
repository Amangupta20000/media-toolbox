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
  result = applyMockRequest(value, { method: "POST", pathname: "/users", body: { name: "Grace" } });
  assert.equal(result.status, 201);
  assert.match(result.body.id, /^users-/);
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
  const created = applyMockRequest(value, { method: "POST", pathname: "/users", body: { name: "Grace" } });
  assert.equal(created.status, 201);
  assert.equal(created.project.collections[0].records.length, 2);
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

test("legacy collection projects normalize without losing CRUD behavior", () => {
  const value = normalizeMockProject({ id: "legacy", name: "Legacy", collections: [{ name: "items", methods: ["GET"], records: [] }] });
  assert.equal(value.version, 2);
  assert.equal(value.mode, "database");
  assert.deepEqual(value.endpoints, []);
  assert.equal(applyMockRequest(value, { method: "GET", pathname: "/items" }).status, 200);
});
