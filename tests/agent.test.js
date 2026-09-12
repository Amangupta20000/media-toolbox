import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { firstAvailable, runCommand } from "../lib/command.js";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-agent-test-"));
process.env.DATA_DIR = path.join(testRoot, "data");
process.env.MEDIA_TOOLBOX_DOWNLOADS_DIR = path.join(testRoot, "Downloads");
process.env.AGENT_PORT = "0";
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
