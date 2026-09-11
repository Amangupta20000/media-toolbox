import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { firstAvailable, runCommand } from "../lib/command.js";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-agent-test-"));
process.env.DATA_DIR = path.join(testRoot, "data");
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
});
