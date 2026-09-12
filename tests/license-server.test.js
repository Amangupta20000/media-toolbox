import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runAgentChild(script, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { cwd: repositoryDirectory, env: environment });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (value) => { stdout += value; });
    child.stderr.on("data", (value) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("licensing server handles approval, online agent redemption, replay, and wrong-origin requests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-license-server-test-"));
  const keys = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const serverConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: root,
    publicOrigins: ["http://localhost:3000"],
    adminUsername: "Admin",
    adminPassword: "12345",
    adminSessionTtlMs: 60 * 60 * 1000,
    requestTtlMs: 60 * 60 * 1000,
    maxBodyBytes: 32 * 1024,
  };
  process.env.LICENSE_ALLOW_NON_SSD = "true";
  process.env.LICENSE_MASTER_KEY = randomBytes(32).toString("base64");
  const { LicenseService } = await import("../license-server/server.js");
  const { LicenseStore } = await import("../license-server/store.js");
  const { bootstrapEncryptedPrivateKey, loadPrivateKey, publicKeyFor } = await import("../license-server/secrets.js");
  await bootstrapEncryptedPrivateKey(keys.privateKey, root);
  const restoredKey = await loadPrivateKey(root);
  assert.deepEqual(publicKeyFor(restoredKey).export({ type: "spki", format: "der" }), publicKeyFor(keys.privateKey).export({ type: "spki", format: "der" }));
  assert.doesNotMatch(await fs.readFile(path.join(root, "signing-key.enc.json"), "utf8"), /BEGIN PRIVATE KEY/);
  const store = new LicenseStore(root);
  const service = new LicenseService({ config: serverConfig, store, privateKey: keys.privateKey });
  const server = await (await import("../license-server/server.js")).createLicenseServer({ service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jsonRequest = (url, options = {}) => fetch(`${base}${url}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });

  try {
    const health = await fetch(`${base}/v1/health`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, "media-toolbox-license-server");

    const invalidOrigin = await jsonRequest("/v1/license-requests", { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ origin: "https://evil.example" }) });
    assert.equal(invalidOrigin.status, 403);

    const invalidDuration = await jsonRequest("/v1/license-requests", { method: "POST", headers: { Origin: "http://localhost:3000" }, body: JSON.stringify({ origin: "http://localhost:3000", requesterLabel: "Chrome user", durationMs: 60 * 60 * 1000 }) });
    assert.equal(invalidDuration.status, 400);

    const createdResponse = await jsonRequest("/v1/license-requests", { method: "POST", headers: { Origin: "http://localhost:3000" }, body: JSON.stringify({ origin: "http://localhost:3000", requesterLabel: "Chrome user", durationMs: 2 * 60 * 60 * 1000 }) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.ok(created.requestId);
    assert.ok(created.requestToken);

    const missingToken = await fetch(`${base}/v1/license-requests/${created.requestId}`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(missingToken.status, 400);

    const badLogin = await jsonRequest("/v1/admin/login", { method: "POST", body: JSON.stringify({ username: "Admin", password: "wrong" }) });
    assert.equal(badLogin.status, 401);
    const login = await jsonRequest("/v1/admin/login", { method: "POST", body: JSON.stringify({ username: "Admin", password: "12345" }) });
    assert.equal(login.status, 200);
    const admin = await login.json();
    assert.ok(admin.token);
    assert.ok(store.getSetting("admin_password_hash"));
    assert.notEqual(store.getSetting("admin_password_hash"), "12345");

    const requests = await fetch(`${base}/v1/admin/license-requests`, { headers: { Authorization: `Bearer ${admin.token}` } });
    assert.equal(requests.status, 200);
    const adminItems = await requests.json();
    assert.equal(adminItems.items.length, 1);
    assert.equal(adminItems.items[0].durationMs, 2 * 60 * 60 * 1000);
    assert.equal(Object.prototype.hasOwnProperty.call(adminItems.items[0], "code"), false);

    const approvedResponse = await fetch(`${base}/v1/admin/license-requests/${created.requestId}/approve`, { method: "POST", headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" }, body: "{}" });
    assert.equal(approvedResponse.status, 200);

    const statusResponse = await fetch(`${base}/v1/license-requests/${created.requestId}?token=${encodeURIComponent(created.requestToken)}`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(statusResponse.status, 200);
    const approved = await statusResponse.json();
    assert.equal(approved.status, "approved");
    assert.match(approved.code, /^MT1-/);

    const childScript = `import { acceptLegalConsent, activateOnline, getAuthorizationState } from "./agent/auth.js";
acceptLegalConsent();
activateOnline(process.env.ACTIVATION_CODE).then(() => { console.log(JSON.stringify(getAuthorizationState())); }).catch((error) => { console.error(error.message); process.exit(1); });`;
    const child = await runAgentChild(childScript, { ...process.env, DATA_DIR: path.join(root, "agent-one"), MEDIA_TOOLBOX_DOWNLOADS_DIR: path.join(root, "Downloads"), AGENT_LICENSE_SERVER_URL: base, AGENT_LICENSE_PUBLIC_KEY: keys.publicKey, ACTIVATION_CODE: approved.code });
    assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /"mode":"activation"/);

    const redeemedStatus = await fetch(`${base}/v1/license-requests/${created.requestId}?token=${encodeURIComponent(created.requestToken)}`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal((await redeemedStatus.json()).status, "redeemed");
    assert.equal((await (await fetch(`${base}/v1/license-requests/${created.requestId}?token=${encodeURIComponent(created.requestToken)}`, { headers: { Origin: "http://localhost:3000" } })).json()).code, undefined);

    const replay = await runAgentChild(childScript, { ...process.env, DATA_DIR: path.join(root, "agent-two"), MEDIA_TOOLBOX_DOWNLOADS_DIR: path.join(root, "Downloads-two"), AGENT_LICENSE_SERVER_URL: base, AGENT_LICENSE_PUBLIC_KEY: keys.publicKey, ACTIVATION_CODE: approved.code });
    assert.notEqual(replay.status, 0, "The same activation code was accepted by a second agent installation.");
    assert.match(`${replay.stdout}\n${replay.stderr}`, /already been used|no longer active|invalid/i);

    const badCode = approved.code.slice(0, -1) + (approved.code.endsWith("A") ? "B" : "A");
    const badRedeem = await jsonRequest("/v1/licenses/redeem", { method: "POST", body: JSON.stringify({ code: badCode, deviceId: "different-device", origin: "http://localhost:3000" }) });
    assert.notEqual(badRedeem.status, 200);
    const logout = await fetch(`${base}/v1/admin/logout`, { method: "POST", headers: { Authorization: `Bearer ${admin.token}` } });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${base}/v1/admin/license-requests`, { headers: { Authorization: `Bearer ${admin.token}` } });
    assert.equal(afterLogout.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("production licensing storage rejects a non-SSD directory", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAllow = process.env.LICENSE_ALLOW_NON_SSD;
  process.env.NODE_ENV = "production";
  delete process.env.LICENSE_ALLOW_NON_SSD;
  const { assertLicenseStorage } = await import("../license-server/storage.js");
  assert.throws(() => assertLicenseStorage(path.join(os.tmpdir(), "media-toolbox-license-not-ssd")), /dedicated SSD/i);
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  if (previousAllow === undefined) delete process.env.LICENSE_ALLOW_NON_SSD; else process.env.LICENSE_ALLOW_NON_SSD = previousAllow;
});

test("license requests are automatically removed according to their status retention window", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-license-cleanup-test-"));
  const { LicenseStore, LICENSE_REQUEST_RETENTION_MS } = await import("../license-server/store.js");
  const store = new LicenseStore(root);
  const now = 1_800_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const create = (label, createdAt = now - day, expiresAt = createdAt + 7 * day) => store.createRequest({
    origin: "http://localhost:3000",
    requesterLabel: label,
    durationMs: 600000,
    now: createdAt,
    expiresAt,
  });
  const approve = (request, approvedAt, licenseId) => store.approve(request.id, {
    licenseId,
    codeHash: `hash-${licenseId}`,
    encryptedCode: { ciphertext: "ciphertext", iv: "iv", tag: "tag" },
    now: approvedAt,
  });
  const redeem = (request, approvedAt, redeemedAt, licenseId) => {
    approve(request, approvedAt, licenseId);
    return store.consume({ licenseId, codeHash: `hash-${licenseId}`, deviceId: `device-${licenseId}`, origin: "http://localhost:3000", now: redeemedAt });
  };

  const oldRedeemed = create("old redeemed", now - 2 * 60 * 60 * 1000);
  redeem(oldRedeemed, now - 90 * 60 * 1000, now - LICENSE_REQUEST_RETENTION_MS.redeemed - 1, "old-redeemed");
  const recentRedeemed = create("recent redeemed", now - 2 * 60 * 60 * 1000);
  redeem(recentRedeemed, now - 90 * 60 * 1000, now - LICENSE_REQUEST_RETENTION_MS.redeemed + 1, "recent-redeemed");

  const oldDeclined = create("old declined", now - 60 * 60 * 1000);
  store.decline(oldDeclined.id, { now: now - LICENSE_REQUEST_RETENTION_MS.declined - 1 });
  const recentDeclined = create("recent declined", now - 60 * 60 * 1000);
  store.decline(recentDeclined.id, { now: now - LICENSE_REQUEST_RETENTION_MS.declined + 1 });

  const oldApproved = create("old approved", now - 2 * day);
  approve(oldApproved, now - LICENSE_REQUEST_RETENTION_MS.approved - 1, "old-approved");
  const recentApproved = create("recent approved", now - 2 * day);
  approve(recentApproved, now - LICENSE_REQUEST_RETENTION_MS.approved + 1, "recent-approved");

  const expiredPending = create("expired pending", now - 2 * day, now - 60 * 60 * 1000);
  const counts = store.cleanup(now);

  assert.deepEqual(counts, {
    expiredAdminSessions: 0,
    expiredPendingRequests: 1,
    deletedRedeemedRequests: 1,
    deletedDeclinedRequests: 1,
    deletedApprovedRequests: 1,
  });
  assert.equal(store.getRequest(oldRedeemed.id), null);
  assert.equal(store.getRequest(oldDeclined.id), null);
  assert.equal(store.getRequest(oldApproved.id), null);
  assert.equal(store.getRequest(recentRedeemed.id).status, "redeemed");
  assert.equal(store.getRequest(recentDeclined.id).status, "declined");
  assert.equal(store.getRequest(recentApproved.id).status, "approved");
  assert.equal(store.getRequest(expiredPending.id).status, "expired");
  assert.ok(store.database.prepare("SELECT 1 FROM license_consumptions WHERE license_id = ?").get("old-redeemed"));
  assert.equal(store.listRequests().some((row) => row.id === oldRedeemed.id || row.id === oldDeclined.id || row.id === oldApproved.id), false);

  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

test("authenticated owner can create or update the agent URL GitHub variable without exposing the token", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-github-variable-test-"));
  const serverConfig = {
    host: "127.0.0.1",
    port: 0,
    dataDir: root,
    publicOrigins: ["http://localhost:3000"],
    adminUsername: "Admin",
    adminPassword: "12345",
    adminSessionTtlMs: 60 * 60 * 1000,
    requestTtlMs: 60 * 60 * 1000,
    maxBodyBytes: 32 * 1024,
    githubRepository: "Amangupta20000/media-toolbox",
    githubApiUrl: "https://api.github.test",
    githubToken: "github-token-that-must-stay-server-side",
  };
  const { LicenseService, createLicenseServer } = await import("../license-server/server.js");
  const { LicenseStore } = await import("../license-server/store.js");
  const store = new LicenseStore(root);
  const service = new LicenseService({ config: serverConfig, store });
  const server = await createLicenseServer({ service });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const githubCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith("https://api.github.test/")) {
      githubCalls.push({ url: String(url), options });
      if (githubCalls.length === 1) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      return new Response("", { status: 201 });
    }
    return originalFetch(url, options);
  };
  try {
    const login = await originalFetch(`${base}/v1/admin/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "Admin", password: "12345" }) });
    const { token } = await login.json();
    const invalid = await originalFetch(`${base}/v1/admin/github/agent-license-server-url`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ url: "http://insecure.example" }) });
    assert.equal(invalid.status, 400);
    assert.equal(githubCalls.length, 0);

    const response = await originalFetch(`${base}/v1/admin/github/agent-license-server-url`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://device-name.tailnet.ts.net" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, name: "AGENT_LICENSE_SERVER_URL", value: "https://device-name.tailnet.ts.net", repository: "Amangupta20000/media-toolbox" });
    assert.equal(githubCalls.length, 2);
    assert.equal(githubCalls[0].options.method, "PATCH");
    assert.equal(githubCalls[1].options.method, "POST");
    assert.equal(githubCalls[0].options.headers.Authorization, "Bearer github-token-that-must-stay-server-side");
    assert.equal(JSON.parse(githubCalls[1].options.body).value, "https://device-name.tailnet.ts.net");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
