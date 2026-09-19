import assert from "node:assert/strict";
import test from "node:test";
import { adminTokenFromRequest, isValidLicenseAdminToken } from "../lib/admin-access.js";

test("admin media URL access requires a valid licensing Admin token", async () => {
  const previousUrl = process.env.NEXT_PUBLIC_LICENSE_SERVER_URL;
  const previousFetch = globalThis.fetch;
  process.env.NEXT_PUBLIC_LICENSE_SERVER_URL = "https://license.example";
  const calls = [];
  globalThis.fetch = async (input, options) => {
    calls.push({ input, options });
    return { ok: options.headers.Authorization === "Bearer valid-admin-token" };
  };
  try {
    assert.equal(adminTokenFromRequest({ headers: { "x-media-toolbox-admin-token": " valid-admin-token " } }), "valid-admin-token");
    assert.equal(await isValidLicenseAdminToken(""), false);
    assert.equal(await isValidLicenseAdminToken("invalid-token"), false);
    assert.equal(await isValidLicenseAdminToken("valid-admin-token"), true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].input, "https://license.example/v1/admin/audit-log?limit=1");
    assert.equal(calls[1].options.headers.Authorization, "Bearer valid-admin-token");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_LICENSE_SERVER_URL;
    else process.env.NEXT_PUBLIC_LICENSE_SERVER_URL = previousUrl;
  }
});
