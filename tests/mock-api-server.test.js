import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-server-mock-"));
process.env.DATA_DIR = dataRoot;

const management = await import("../pages/api/mock-apis/index.js");
const projectManagement = await import("../pages/api/mock-apis/[id].js");
const runtime = await import("../pages/api/mock/[projectId]/[[...path]].js");
const storage = await import("../lib/mock-api-storage.js");

class MockResponse {
  constructor() {
    this.headers = {};
    this.statusCode = 200;
    this.body = undefined;
    this.ended = false;
  }

  setHeader(name, value) { this.headers[name] = value; }
  status(value) { this.statusCode = value; return this; }
  json(value) { this.body = value; return this; }
  end() { this.ended = true; return this; }
}

async function invoke(handler, request) {
  const response = new MockResponse();
  await handler(request, response);
  return response;
}

function consentProject() {
  return {
    id: "server-consent",
    name: "Server consent API",
    mode: "database",
    collections: [{
      name: "myapi",
      methods: ["GET", "POST"],
      records: [{
        id: "record-1",
        clientid: "Ada Love",
        skills: ["existing"],
        consentData: { data: { purposeDetails: [{ id: "skill-1", hasUserProvidedConsent: false }] } },
      }],
    }],
    endpoints: [
      { id: "consent-get", method: "GET", path: "/sso/api/v1/consent", collection: "myapi" },
      {
        id: "consent-submit",
        method: "POST",
        path: "/sso/api/v1/consent/submit-user-consent",
        collection: "myapi",
        postAction: {
          type: "update",
          recordMatch: [{ recordPath: "clientid", source: "header.name", operator: "equals" }],
          nestedUpdates: [{
            arrayPath: "consentData.data.purposeDetails",
            matchPath: "id",
            source: "body.purpose_ids",
            operator: "in",
            set: { hasUserProvidedConsent: true },
          }],
        },
        responses: { success: { status: 200, body: { success: true } } },
      },
    ],
  };
}

test.after(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true });
});

test("Server Mock API route persists guided POST mutations on multi-segment paths", async () => {
  const saved = await invoke(management.default, { method: "POST", body: consentProject(), query: {}, headers: {} });
  assert.equal(saved.statusCode, 201);
  assert.equal(saved.body.project.id, "server-consent");

  const preflight = await invoke(runtime.default, {
    method: "OPTIONS",
    query: { projectId: "server-consent", path: ["sso", "api", "v1", "consent", "submit-user-consent"] },
    url: "/api/mock/server-consent/sso/api/v1/consent/submit-user-consent",
    headers: { "access-control-request-headers": "content-type, name" },
  });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["Access-Control-Allow-Headers"], "content-type, name");

  const posted = await invoke(runtime.default, {
    method: "POST",
    query: { projectId: "server-consent", path: ["sso", "api", "v1", "consent", "submit-user-consent"] },
    url: "/api/mock/server-consent/sso/api/v1/consent/submit-user-consent",
    headers: { name: "Ada Love", "content-type": "application/json" },
    body: { purpose_ids: ["skill-1"] },
  });
  assert.equal(posted.statusCode, 200);
  assert.deepEqual(posted.body, { success: true });

  const updated = await storage.getMockProject("server-consent");
  assert.equal(updated.collections[0].records[0].consentData.data.purposeDetails[0].hasUserProvidedConsent, true);
});

test("Server Mock API route supports PUT, PATCH, and DELETE record operations", async () => {
  const saved = await invoke(management.default, {
    method: "POST",
    body: {
      id: "server-crud",
      name: "Server CRUD API",
      mode: "database",
      collections: [{ name: "users", methods: ["GET", "PUT", "PATCH", "DELETE"], records: [{ id: "1", name: "Ada", role: "admin" }] }],
      endpoints: [
        { id: "users-get", method: "GET", path: "/sso/api/v1/users", collection: "users" },
        { id: "users-put", method: "PUT", path: "/sso/api/v1/users", collection: "users" },
        { id: "users-patch", method: "PATCH", path: "/sso/api/v1/users", collection: "users" },
        { id: "users-delete", method: "DELETE", path: "/sso/api/v1/users", collection: "users" },
      ],
    },
    query: {},
    headers: {},
  });
  assert.equal(saved.statusCode, 201);

  const put = await invoke(runtime.default, {
    method: "PUT",
    query: { projectId: "server-crud", path: ["sso", "api", "v1", "users", "1"] },
    url: "/api/mock/server-crud/sso/api/v1/users/1",
    headers: { "content-type": "application/json" },
    body: { name: "Grace", active: true },
  });
  assert.equal(put.statusCode, 200);
  assert.deepEqual(put.body, { id: "1", name: "Grace", active: true });

  const patch = await invoke(runtime.default, {
    method: "PATCH",
    query: { projectId: "server-crud", path: ["sso", "api", "v1", "users", "1"] },
    url: "/api/mock/server-crud/sso/api/v1/users/1",
    headers: { "content-type": "application/json" },
    body: { role: "engineer" },
  });
  assert.equal(patch.statusCode, 200);
  assert.deepEqual(patch.body, { id: "1", name: "Grace", active: true, role: "engineer" });

  const deleted = await invoke(runtime.default, {
    method: "DELETE",
    query: { projectId: "server-crud", path: ["sso", "api", "v1", "users", "1"] },
    url: "/api/mock/server-crud/sso/api/v1/users/1",
    headers: {},
  });
  assert.equal(deleted.statusCode, 204);
  const persisted = await storage.getMockProject("server-crud");
  assert.deepEqual(persisted.collections[0].records, []);
});

test("Server Mock API returns 404 and does not persist a mutation when nothing matches", async () => {
  const posted = await invoke(runtime.default, {
    method: "POST",
    query: { projectId: "server-consent", path: ["sso", "api", "v1", "consent", "submit-user-consent"] },
    url: "/api/mock/server-consent/sso/api/v1/consent/submit-user-consent",
    headers: { name: "Nobody", "content-type": "application/json" },
    body: { purpose_ids: ["missing"] },
  });
  assert.equal(posted.statusCode, 404);
  const unchanged = await storage.getMockProject("server-consent");
  assert.equal(unchanged.collections[0].records[0].skills[0], "existing");
  assert.equal(unchanged.collections[0].records[0].consentData.data.purposeDetails[0].hasUserProvidedConsent, true);
});
