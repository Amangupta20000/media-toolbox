import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";

const repositoryDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealth(baseUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`The local agent exited before becoming ready.\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/v1/health`);
      if (response.ok) return response.json();
    } catch {
      // The entrypoint may still be loading native dependencies.
    }
    await wait(100);
  }
  throw new Error(`The local agent did not become ready.\n${output.join("")}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    wait(3000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("local agent entrypoint starts and completes a local image job", async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-local-runtime-"));
  const port = await freePort();
  const output = [];
  const agentEnvironment = {
    ...process.env,
    DATA_DIR: path.join(testRoot, "data"),
    MEDIA_TOOLBOX_DOWNLOADS_DIR: path.join(testRoot, "Downloads"),
    AGENT_PORT: String(port),
    AGENT_PROTOCOL: "http",
    AGENT_LICENSE_PUBLIC_KEY: "",
    AGENT_LICENSE_PUBLIC_KEY_FILE: "",
  };
  const child = spawn(process.execPath, [path.join(repositoryDirectory, "agent", "index.js")], {
    cwd: repositoryDirectory,
    env: agentEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await waitForHealth(baseUrl, child, output);
    assert.equal(health.ok, true);
    assert.equal(health.authorization.mode, "locked");
    assert.equal(health.authorization.legalAccepted, false);
    assert.equal(health.authorization.trialAvailable, true);
    assert.equal(health.trialAvailable, false);
    assert.equal(health.authorization.trialStartedAt, null);

    const blockedSessionResponse = await fetch(`${baseUrl}/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Local runtime test" }),
    });
    assert.equal(blockedSessionResponse.status, 402);
    assert.equal((await blockedSessionResponse.json()).code, "legal_consent_required");

    await new Promise((resolve, reject) => {
      const consentProcess = spawn(process.execPath, ["--input-type=module", "-e", "import('./agent/auth.js').then(({ acceptLegalConsent }) => acceptLegalConsent()).catch((error) => { console.error(error); process.exitCode = 1; })"], {
        cwd: repositoryDirectory,
        env: agentEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let consentError = "";
      consentProcess.stderr.on("data", (chunk) => { consentError += chunk.toString(); });
      consentProcess.once("error", reject);
      consentProcess.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`The local agent consent setup failed: ${consentError}`)));
    });

    const sessionResponse = await fetch(`${baseUrl}/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Local runtime test" }),
    });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.authorization.mode, "trial");
    assert.ok(session.token);

    const form = new FormData();
    form.append("tool", "image-converter");
    form.append("format", "png");
    form.append("method", "auto");
    form.append("jpegConfirmed", "false");
    form.append("retention", "delete");
    const source = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    form.append("source", new Blob([source], { type: "image/png" }), "runtime.png");
    const jobResponse = await fetch(`${baseUrl}/v1/jobs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.token}`, Origin: "http://localhost:3000" },
      body: form,
    });
    assert.equal(jobResponse.status, 202);
    const queued = await jobResponse.json();

    let completed;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const statusResponse = await fetch(`${baseUrl}/v1/jobs/${queued.jobId}`, {
        headers: { Authorization: `Bearer ${session.token}`, Origin: "http://localhost:3000" },
      });
      completed = await statusResponse.json();
      if (["completed", "failed"].includes(completed.status)) break;
      await wait(100);
    }
    assert.equal(completed.status, "completed", `${completed.error || completed.message}\n${output.join("")}`);
    assert.ok(completed.result?.downloadUrl);

    const download = await fetch(completed.result.downloadUrl, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "image/png");
    assert.ok((await download.arrayBuffer()).byteLength > 0);
  } finally {
    await stopChild(child);
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});
