import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { firstAvailable, runCommand } from "../lib/command.js";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-agent-test-"));
process.env.DATA_DIR = path.join(testRoot, "data");
process.env.MEDIA_TOOLBOX_DOWNLOADS_DIR = path.join(testRoot, "Downloads");
process.env.AGENT_PORT = "0";
const licenseKeys = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
process.env.AGENT_LICENSE_PUBLIC_KEY = licenseKeys.publicKey;
const agent = await import("../agent/server.js");
let server;
let port;
let sessionToken;

before(async () => {
  server = await agent.startAgentServer({ port: 0 });
  port = server.address().port;
});

after(async () => {
  await agent.stopAgentServer();
  await fs.rm(testRoot, { recursive: true, force: true });
});

const url = (pathName) => `http://127.0.0.1:${port}${pathName}`;
const encodeLicensePart = (value) => Buffer.from(value).toString("base64").replace(/=+$/g, "");
const makeActivationCode = ({ deviceId = agent.getDeviceId(), origins = ["http://localhost:3000", "http://127.0.0.1:3000"], issuedAt = Date.now(), durationMs = 10 * 60 * 1000 } = {}) => {
  const payload = { v: 1, licenseId: randomUUID(), origins, issuedAt, durationMs };
  if (deviceId) payload.deviceId = deviceId;
  const payloadText = encodeLicensePart(JSON.stringify(payload));
  const signature = encodeLicensePart(sign(null, Buffer.from(payloadText), licenseKeys.privateKey));
  return `MT1-${`${payloadText}.${signature}`.match(/.{1,4}/g).join("-")}`;
};

test("agent starts a persistent five-minute trial without login or activation", async () => {
  const initialHealth = await fetch(url("/v1/health"), { headers: { Origin: "http://localhost:3000" } });
  const initialState = await initialHealth.json();
  assert.equal(initialState.authorization.mode, "locked");
  assert.equal(initialState.authorization.authorized, false);
  assert.equal(initialState.authorization.legalAccepted, false);
  assert.equal(initialState.authorization.reason, "legal_consent_required");
  assert.equal(initialState.authorization.trialAvailable, true);
  assert.equal(initialState.authorization.trialStartedAt, null);
  assert.equal(initialState.trialAvailable, false);
  assert.throws(() => agent.loginAdmin("Admin", "12345"), /Privacy Policy|Terms/i);

  const blockedSession = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Before consent" }),
  });
  assert.equal(blockedSession.status, 402);
  assert.equal((await blockedSession.json()).code, "legal_consent_required");

  const accepted = agent.acceptLegal();
  assert.equal(accepted.legalAccepted, true);
  assert.equal(accepted.legalVersion, "1.0.0");
  assert.equal(accepted.mode, "locked");

  // Repeated health checks are discovery only. They must never consume the
  // installation trial or create a browser session.
  const secondHealth = await fetch(url("/v1/health"), { headers: { Origin: "http://localhost:3000" } });
  const secondState = await secondHealth.json();
  assert.equal(secondState.authorization.legalAccepted, true);
  assert.equal(secondState.authorization.trialStartedAt, null);
  assert.equal(secondState.trialAvailable, true);
  assert.equal(secondState.sessionCount, 0);

  const noSessionCapabilities = await fetch(url("/v1/capabilities"), { headers: { Origin: "http://localhost:3000" } });
  assert.equal(noSessionCapabilities.status, 401);

  const sessionResponse = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Trial browser" }),
  });
  assert.equal(sessionResponse.status, 200);
  const trialSession = await sessionResponse.json();
  assert.equal(trialSession.authorization.mode, "trial");
  assert.equal(trialSession.autoPaired, true);
  assert.ok(trialSession.authorization.trialStartedAt);
  assert.equal(trialSession.authorization.trialExpiresAt - trialSession.authorization.trialStartedAt, 5 * 60 * 1000);

  const trialForm = new FormData();
  trialForm.append("tool", "image-converter");
  trialForm.append("format", "png");
  trialForm.append("method", "imagemagick");
  trialForm.append("jpegConfirmed", "false");
  trialForm.append("retention", "delete");
  trialForm.append("source", new Blob([Buffer.from("not a real image")], { type: "image/png" }), "trial.png");
  const trialJobResponse = await fetch(url("/v1/jobs"), {
    method: "POST",
    headers: { Authorization: `Bearer ${trialSession.token}`, Origin: "http://localhost:3000" },
    body: trialForm,
  });
  assert.equal(trialJobResponse.status, 202);
  const trialJob = await trialJobResponse.json();
  assert.ok(trialJob.jobId);

  let terminalJob;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const statusResponse = await fetch(url(`/v1/jobs/${trialJob.jobId}`), { headers: { Authorization: `Bearer ${trialSession.token}`, Origin: "http://localhost:3000" } });
    terminalJob = await statusResponse.json();
    if (["completed", "failed"].includes(terminalJob.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(["completed", "failed"].includes(terminalJob.status));
  const deletedTrialJob = await fetch(url(`/v1/jobs/${trialJob.jobId}`), { method: "DELETE", headers: { Authorization: `Bearer ${trialSession.token}`, Origin: "http://localhost:3000" } });
  assert.equal(deletedTrialJob.status, 200);

  const startedAt = trialSession.authorization.trialStartedAt;
  await agent.stopAgentServer();
  server = await agent.startAgentServer({ port: 0 });
  port = server.address().port;
  const afterRestart = agent.getAgentState().authorization;
  assert.equal(afterRestart.mode, "trial");
  assert.equal(afterRestart.trialStartedAt, startedAt);

  const expired = (await import("../agent/auth.js")).getAuthorizationState(startedAt + 5 * 60 * 1000 + 1);
  assert.equal(expired.mode, "locked");
  assert.equal(expired.reason, "trial_expired");
  const deniedAfterExpiry = (await import("../agent/auth.js")).authorizeProcessing("http://localhost:3000", startedAt + 5 * 60 * 1000 + 1);
  assert.equal(deniedAfterExpiry.ok, false);
  assert.equal(deniedAfterExpiry.code, "activation_required");
});

test("agent persists Admin authorization across restarts and rejects bad credentials", async () => {
  assert.throws(() => agent.loginAdmin("Admin", "wrong"), /incorrect/i);
  agent.loginAdmin("Admin", "12345");
  assert.equal(agent.getAgentState().authorization.mode, "admin");

  const adminSessionResponse = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Admin browser" }),
  });
  assert.equal(adminSessionResponse.status, 200);
  const adminSession = await adminSessionResponse.json();
  agent.logoutAdmin();
  const revokedAdminAccess = await fetch(url("/v1/capabilities"), { headers: { Authorization: `Bearer ${adminSession.token}`, Origin: "http://localhost:3000" } });
  assert.equal(revokedAdminAccess.status, 401);
  agent.loginAdmin("Admin", "12345");

  await agent.stopAgentServer();
  server = await agent.startAgentServer({ port: 0 });
  port = server.address().port;
  assert.equal(agent.getAgentState().authorization.mode, "admin");
  agent.logoutAdmin();
  // Logging out removes the Admin override and returns to the still-running
  // installation trial; it must not reset or silently extend that trial.
  assert.equal(agent.getAgentState().authorization.mode, "trial");
});

test("agent accepts only a signed, device-bound, one-use activation code", () => {
  assert.throws(() => agent.activateLicense(makeActivationCode({ deviceId: "different-device" })), /different device/i);
  assert.throws(() => agent.activateLicense(makeActivationCode({ deviceId: null })), /not bound to a device/i);
  const code = makeActivationCode();
  const compactCode = code.slice(4).replace(/-/g, "");
  const payload = JSON.parse(Buffer.from(compactCode.slice(0, compactCode.indexOf(".")), "base64url").toString("utf8"));
  assert.equal(payload.deviceId, agent.getDeviceId());
  const signatureStart = compactCode.indexOf(".") + 1;
  const signatureChar = compactCode[signatureStart];
  const tamperedCompact = `${compactCode.slice(0, signatureStart)}${signatureChar === "A" ? "B" : "A"}${compactCode.slice(signatureStart + 1)}`;
  const tampered = `MT1-${tamperedCompact.match(/.{1,4}/g).join("-")}`;
  assert.throws(() => agent.activateLicense(tampered), /signature is invalid/i);

  // The used-license table is local to an installation, so this regression
  // uses a fresh process and data directory to prove device binding prevents
  // the same signed token being accepted somewhere else.
  const otherRoot = path.join(testRoot, "other-installation");
  const childScript = `import { acceptLegalConsent, activate } from "./agent/auth.js";
acceptLegalConsent();
try { activate(process.env.ACTIVATION_CODE); process.exit(0); }
catch (error) { console.error(error.message); process.exit(1); }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    env: {
      ...process.env,
      DATA_DIR: path.join(otherRoot, "data"),
      MEDIA_TOOLBOX_DOWNLOADS_DIR: path.join(otherRoot, "Downloads"),
      AGENT_LICENSE_PUBLIC_KEY: licenseKeys.publicKey,
      ACTIVATION_CODE: code,
    },
    encoding: "utf8",
  });
  assert.notEqual(child.status, 0, `A device-bound activation code was accepted by a second installation: ${child.stdout}${child.stderr}`);
  assert.match(`${child.stdout}\n${child.stderr}`, /different device/i);

  agent.activateLicense(code);
  assert.equal(agent.getAgentState().authorization.mode, "activation");
  assert.throws(() => agent.activateLicense(code), /already been used/i);
});

test("agent reports health, rejects unauthenticated jobs, and pairs with a one-time code", async () => {
  const healthResponse = await fetch(url("/v1/health"), { headers: { Origin: "http://localhost:3000" } });
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).ok, true);

  const unauthorized = await fetch(url("/v1/capabilities"), { headers: { Origin: "http://localhost:3000" } });
  assert.equal(unauthorized.status, 401);

  const badPair = await fetch(url("/v1/pair"), { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ code: "000000", origin: "http://localhost:3000" }) });
  assert.equal(badPair.status, 401);

  const goodPair = await fetch(url("/v1/pair"), { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ code: agent.getAgentState().pairingCode, origin: "http://localhost:3000" }) });
  assert.equal(goodPair.status, 200);
  const paired = await goodPair.json();
  assert.ok(paired.token);
  sessionToken = paired.token;

  const capabilities = await fetch(url("/v1/capabilities"), { headers: { Authorization: `Bearer ${paired.token}`, Origin: "http://localhost:3000" } });
  assert.equal(capabilities.status, 200);

  // Native/non-browser callers may omit Origin. A valid paired token must
  // still authorize the request; this also covers the browser pairing race.
  const capabilitiesWithoutOrigin = await fetch(url("/v1/capabilities"), { headers: { Authorization: `Bearer ${paired.token}` } });
  assert.equal(capabilitiesWithoutOrigin.status, 200);
});

test("agent rejects a different origin after pairing", async () => {
  const response = await fetch(url("/v1/capabilities"), { headers: { Authorization: "Bearer invalid", Origin: "http://evil.example" } });
  assert.equal(response.status, 401);
});

test("agent deletes a named downloaded server result only inside Downloads", async () => {
  const downloadsDirectory = path.join(testRoot, "Downloads");
  const resultName = "server-result.pdf";
  await fs.mkdir(downloadsDirectory, { recursive: true });
  await fs.writeFile(path.join(downloadsDirectory, resultName), "downloaded result");

  const unauthorized = await fetch(url("/v1/files/delete"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ folderPath: downloadsDirectory, filename: resultName }),
  });
  assert.equal(unauthorized.status, 401);

  const deleted = await fetch(url("/v1/files/delete"), {
    method: "POST",
    headers: { "Authorization": `Bearer ${sessionToken}`, "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ folderPath: downloadsDirectory, filename: resultName }),
  });
  assert.equal(deleted.status, 200);
  assert.equal((await fs.stat(path.join(downloadsDirectory, resultName)).catch(() => null)), null);

  const outsideDirectory = path.join(testRoot, "outside");
  await fs.mkdir(outsideDirectory, { recursive: true });
  await fs.writeFile(path.join(outsideDirectory, resultName), "must stay");
  const rejected = await fetch(url("/v1/files/delete"), {
    method: "POST",
    headers: { "Authorization": `Bearer ${sessionToken}`, "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ folderPath: outsideDirectory, filename: resultName }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await fs.stat(path.join(outsideDirectory, resultName))).isFile(), true);
});

test("agent accepts an authenticated image job and returns a local result", async (t) => {
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (!imageTool) {
    t.skip("ImageMagick is required for the local-agent image fixture.");
    return;
  }
  const sourcePath = path.join(testRoot, "agent-source.png");
  const command = imageTool === "magick" ? "magick" : "convert";
  const created = await runCommand(command, ["-size", "80x50", "xc:skyblue", sourcePath]);
  assert.equal(created.code, 0, created.stderr);
  const form = new FormData();
  form.append("tool", "image-converter");
  form.append("format", "png");
  form.append("method", "imagemagick");
  form.append("jpegConfirmed", "false");
  form.append("retention", "keep");
  form.append("source", new Blob([await fs.readFile(sourcePath)], { type: "image/png" }), "agent-source.png");
  const response = await fetch(url("/v1/jobs"), {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" },
    body: form,
  });
  assert.equal(response.status, 202);
  const createdJob = await response.json();
  assert.ok(createdJob.jobId);

  let completed;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const statusResponse = await fetch(url(`/v1/jobs/${createdJob.jobId}`), { headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" } });
    completed = await statusResponse.json();
    if (["completed", "failed"].includes(completed.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(completed.status, "completed", completed.error || completed.message);
  assert.match(completed.result.filename, /agent-source_converted\.png$/);
  const download = await fetch(completed.result.downloadUrl, { headers: { Origin: "http://localhost:3000" } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "image/png");
  assert.equal((await download.arrayBuffer()).byteLength > 0, true);

  const historyResponse = await fetch(url("/v1/history?tool=image-converter"), { headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" } });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  const retained = history.items.find((item) => item.id === createdJob.jobId);
  assert.ok(retained);
  assert.equal(retained.storedLocally, true);
  assert.match(retained.location, /Results folder/);

  const deleted = await fetch(url(`/v1/history/${createdJob.jobId}`), { method: "DELETE", headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" } });
  assert.equal(deleted.status, 200);
  const missing = await fetch(url(`/v1/jobs/${createdJob.jobId}`), { headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" } });
  assert.equal(missing.status, 404);
});

test("agent supports automatic browser sessions and ending one or all sessions", async () => {
  const automatic = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Safari on macOS" }),
  });
  assert.equal(automatic.status, 200);
  const automaticSession = await automatic.json();
  assert.ok(automaticSession.token);
  assert.ok(automaticSession.sessionId);
  assert.equal(automaticSession.autoPaired, true);

  const secondBrowser = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:3000" },
    body: JSON.stringify({ origin: "http://127.0.0.1:3000", clientLabel: "Chrome private window" }),
  });
  assert.equal(secondBrowser.status, 200);
  const secondBrowserSession = await secondBrowser.json();
  assert.equal(secondBrowserSession.autoPaired, true);

  const differentOrigin = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://another.example" },
    body: JSON.stringify({ origin: "https://another.example", clientLabel: "Chrome" }),
  });
  assert.equal(differentOrigin.status, 403);

  const sessionsResponse = await fetch(url("/v1/sessions"), {
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" },
  });
  assert.equal(sessionsResponse.status, 200);
  const sessions = await sessionsResponse.json();
  assert.ok(sessions.items.some((item) => item.id === automaticSession.sessionId && item.clientLabel === "Safari on macOS"));
  assert.ok(sessions.items.some((item) => item.id === secondBrowserSession.sessionId && item.clientLabel === "Chrome private window"));
  assert.ok(sessions.items.some((item) => item.current));

  const ended = await fetch(url(`/v1/sessions/${automaticSession.sessionId}`), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" },
  });
  assert.equal(ended.status, 200);
  assert.equal((await ended.json()).current, false);
  const endedAccess = await fetch(url("/v1/capabilities"), {
    headers: { Authorization: `Bearer ${automaticSession.token}`, Origin: "http://localhost:3000" },
  });
  assert.equal(endedAccess.status, 401);

  const endedAll = await fetch(url("/v1/sessions/revoke-all"), {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" },
  });
  assert.equal(endedAll.status, 200);
  assert.ok((await endedAll.json()).revokedCount >= 1);
  const healthAfterRevoke = await fetch(url("/v1/health"), { headers: { Origin: "http://localhost:3000" } });
  assert.equal((await healthAfterRevoke.json()).paired, false);
});

test("activation authorization expires after exactly ten minutes", async () => {
  const active = agent.getAgentState().authorization;
  assert.equal(active.mode, "activation");
  assert.equal(active.activationExpiresAt - active.activationStartedAt, 10 * 60 * 1000);
  assert.ok(active.remainingMs > 0 && active.remainingMs <= 10 * 60 * 1000);

  const auth = await import("../agent/auth.js");
  const expired = auth.getAuthorizationState(active.activationStartedAt + 10 * 60 * 1000 + 1);
  assert.equal(expired.mode, "locked");
  assert.equal(expired.authorized, false);
  const denied = auth.authorizeProcessing("http://localhost:3000", active.activationStartedAt + 10 * 60 * 1000 + 1);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "activation_required");
});
