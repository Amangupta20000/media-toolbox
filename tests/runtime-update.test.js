import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  compareVersions,
  createRuntimeUpdater,
  manifestPayload,
  manifestUpdateType,
  readInstalledRuntime,
  verifyRuntimeManifest,
  extractZipArchive,
} = require("../agent/runtime-update.cjs");

function crc32(buffer) {
  let value = 0xFFFFFFFF;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xEDB88320 & -(value & 1));
  }
  return (value ^ 0xFFFFFFFF) >>> 0;
}

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [filename, content] of entries) {
    const name = Buffer.from(filename);
    const value = Buffer.from(content);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc32(value), 14);
    local.writeUInt32LE(value.length, 18);
    local.writeUInt32LE(value.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, value);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc32(value), 16);
    central.writeUInt32LE(value.length, 20);
    central.writeUInt32LE(value.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + value.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

function makeFixture(version = "1.0.27", updateType = "runtime") {
  const keys = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const entries = [
    ["package.json", JSON.stringify({ name: "media-toolbox-agent-runtime", version, type: "module" })],
    ["agent/server.js", "export const runtimeFixture = true;\n"],
  ];
  const archive = storedZip(entries);
  const files = entries.map(([filename, content]) => {
    const value = Buffer.from(content);
    return { path: filename, size: value.length, sha256: createHash("sha256").update(value).digest("hex"), mode: 0o644 };
  });
  const manifest = {
    schema: 1,
    version,
    platform: process.platform,
    arch: process.arch,
    fileName: `Media-Toolbox-Agent-Runtime-${version}-${process.platform}-${process.arch}.zip`,
    url: `Media-Toolbox-Agent-Runtime-${version}-${process.platform}-${process.arch}.zip`,
    updateType,
    sha256: createHash("sha256").update(archive).digest("hex"),
    size: archive.length,
    files,
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
  manifest.signature = sign(null, Buffer.from(manifestPayload(manifest)), keys.privateKey).toString("base64");
  return { keys, archive, manifest };
}

function responseFor(value) {
  return new Response(value, { status: 200, headers: { "content-length": String(Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value))) } });
}

test("verified runtime updater checks, streams, installs, and reopens a signed package", async () => {
  const fixture = makeFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-runtime-update-test-"));
  const manifestUrl = `https://updates.example.test/releases/latest/download/agent-runtime-manifest-${process.platform}-${process.arch}.json`;
  const fetchImpl = async (url) => url === manifestUrl ? { ok: true, status: 200, json: async () => fixture.manifest } : responseFor(fixture.archive);
  try {
    const options = {
      userDataPath: root,
      latestReleaseUrl: "https://updates.example.test/releases/latest",
      env: { AGENT_RUNTIME_UPDATE_PUBLIC_KEY: fixture.keys.publicKey },
      fetchImpl,
      getCurrentVersion: () => "1.0.26",
    };
    const updater = createRuntimeUpdater(options);
    assert.equal((await updater.check()).status, "available");
    assert.equal((await updater.download()).status, "downloaded");

    const reopened = createRuntimeUpdater(options);
    const pending = await reopened.check();
    assert.equal(pending.status, "downloaded");
    assert.equal(pending.version, "1.0.27");
    assert.equal((await reopened.install()).status, "installed");

    const installed = await readInstalledRuntime({ userDataPath: root, env: { AGENT_RUNTIME_UPDATE_PUBLIC_KEY: fixture.keys.publicKey } });
    assert.equal(installed.manifest.version, "1.0.27");
    assert.equal(await fs.readFile(path.join(installed.directory, "agent", "server.js"), "utf8"), "export const runtimeFixture = true;\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runtime updater rejects modified archives, invalid signatures, unsafe paths, and insecure assets", async () => {
  const fixture = makeFixture();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-runtime-update-invalid-test-"));
  const manifestUrl = `https://updates.example.test/releases/latest/download/agent-runtime-manifest-${process.platform}-${process.arch}.json`;
  try {
    const updater = createRuntimeUpdater({
      userDataPath: root,
      latestReleaseUrl: "https://updates.example.test/releases/latest",
      env: { AGENT_RUNTIME_UPDATE_PUBLIC_KEY: fixture.keys.publicKey },
      fetchImpl: async (url) => url === manifestUrl ? { ok: true, status: 200, json: async () => fixture.manifest } : responseFor(Buffer.concat([fixture.archive, Buffer.from("tampered")])) ,
      getCurrentVersion: () => "1.0.26",
    });
    assert.equal((await updater.check()).status, "available");
    const failedDownload = await updater.download();
    assert.equal(failedDownload.status, "error");
    assert.match(failedDownload.error, /SHA-256/i);

    const invalidSignature = { ...fixture.manifest, signature: "invalid" };
    assert.throws(() => verifyRuntimeManifest(invalidSignature, fixture.keys.publicKey, { platform: process.platform, arch: process.arch }), /signature/i);
    const unsafeManifest = { ...fixture.manifest, files: fixture.manifest.files.map((entry) => ({ ...entry, path: entry.path === "package.json" ? "../package.json" : entry.path })) };
    assert.throws(() => verifyRuntimeManifest(unsafeManifest, fixture.keys.publicKey, { platform: process.platform, arch: process.arch }), /unsafe/i);

    const insecureUpdater = createRuntimeUpdater({
      userDataPath: root,
      latestReleaseUrl: "http://updates.example.test/releases/latest",
      env: { AGENT_RUNTIME_UPDATE_PUBLIC_KEY: fixture.keys.publicKey },
      fetchImpl: async () => responseFor(JSON.stringify(fixture.manifest)),
      getCurrentVersion: () => "1.0.26",
    });
    assert.equal((await insecureUpdater.check()).status, "available");
    await assert.rejects(() => insecureUpdater.download(), /HTTPS origin/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runtime updater version comparison and missing-key behavior are deterministic", async () => {
  assert.equal(compareVersions("1.0.10", "1.0.9"), 1);
  assert.equal(compareVersions("1.0.0-beta", "1.0.0"), -1);
  assert.equal(manifestUpdateType({}), "runtime");
  assert.equal(manifestUpdateType({ updateType: "full" }), "full");
  assert.equal(manifestUpdateType({ updateType: "unsupported" }), "");
  const updater = createRuntimeUpdater({ userDataPath: await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-runtime-update-no-key-")), latestReleaseUrl: "https://updates.example.test/releases/latest", env: {}, getCurrentVersion: () => "1.0.26" });
  assert.equal((await updater.check()).status, "unavailable");
});

test("full installer manifests block runtime installation and are surfaced clearly", async () => {
  const fixture = makeFixture("1.2.0", "full");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-runtime-update-full-test-"));
  try {
    const updater = createRuntimeUpdater({
      userDataPath: root,
      latestReleaseUrl: "https://updates.example.test/releases/latest",
      env: { AGENT_RUNTIME_UPDATE_PUBLIC_KEY: fixture.keys.publicKey },
      fetchImpl: async () => responseFor(JSON.stringify(fixture.manifest)),
      getCurrentVersion: () => "1.1.5",
    });
    const state = await updater.check();
    assert.equal(state.status, "full-required");
    assert.equal(state.updateType, "full");
    assert.match(state.error, /full agent installer update/i);
    await assert.rejects(() => updater.download(), /full agent installer update/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an installed full release is considered current after manual installation", async () => {
  const fixture = makeFixture("1.1.5", "full");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-runtime-update-full-current-test-"));
  const activeDirectory = path.join(root, "agent-runtime");
  try {
    await fs.mkdir(path.join(activeDirectory, "agent"), { recursive: true });
    await fs.writeFile(path.join(activeDirectory, "package.json"), JSON.stringify({ name: "media-toolbox-agent-runtime", version: fixture.manifest.version, type: "module" }));
    await fs.writeFile(path.join(activeDirectory, "agent", "server.js"), "export const runtimeFixture = true;\n");
    await fs.writeFile(path.join(activeDirectory, "runtime-manifest.json"), `${JSON.stringify(fixture.manifest)}\n`);
    const updater = createRuntimeUpdater({
      userDataPath: root,
      latestReleaseUrl: "https://updates.example.test/releases/latest",
      env: { AGENT_RUNTIME_UPDATE_PUBLIC_KEY: fixture.keys.publicKey },
      fetchImpl: async () => responseFor(JSON.stringify(fixture.manifest)),
      getCurrentVersion: () => "1.1.5",
    });
    const state = await updater.check();
    assert.equal(state.status, "up-to-date");
    assert.equal(state.version, "1.1.5");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("full installer version takes precedence over an older saved runtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-runtime-update-stale-runtime-"));
  const stale = makeFixture("1.0.30");
  const latest = makeFixture("1.1.0");
  const staleArchive = path.join(root, "stale-runtime.zip");
  const activeDirectory = path.join(root, "agent-runtime");
  try {
    await fs.writeFile(staleArchive, stale.archive);
    await extractZipArchive(staleArchive, activeDirectory);
    const staleManifest = { ...stale.manifest };
    staleManifest.signature = sign(null, Buffer.from(manifestPayload(staleManifest)), latest.keys.privateKey).toString("base64");
    await fs.writeFile(path.join(activeDirectory, "runtime-manifest.json"), `${JSON.stringify(staleManifest)}\n`);
    const updater = createRuntimeUpdater({
      userDataPath: root,
      latestReleaseUrl: "https://updates.example.test/releases/latest",
      env: { AGENT_RUNTIME_UPDATE_PUBLIC_KEY: latest.keys.publicKey },
      fetchImpl: async () => responseFor(JSON.stringify(latest.manifest)),
      getCurrentVersion: () => "1.1.0",
    });
    const state = await updater.check();
    assert.equal(state.status, "up-to-date");
    assert.equal(state.version, "1.1.0");
    assert.equal(state.currentVersion, "1.1.0");
    assert.equal(state.runtimeVersion, "1.1.0");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runtime updater retries manifest checks and reports a bounded timeout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-runtime-update-timeout-"));
  const fixture = makeFixture("1.0.30");
  let attempts = 0;
  try {
    const updater = createRuntimeUpdater({
      userDataPath: root,
      latestReleaseUrl: "https://updates.example.test/releases/latest",
      env: { AGENT_RUNTIME_UPDATE_PUBLIC_KEY: fixture.keys.publicKey },
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("network timeout");
        return responseFor(JSON.stringify(fixture.manifest));
      },
      getCurrentVersion: () => "1.0.29",
      checkTimeoutMs: 50,
      checkRetries: 1,
    });
    assert.equal((await updater.check()).status, "available");
    assert.equal(attempts, 2);

    const timedOut = createRuntimeUpdater({
      userDataPath: root,
      latestReleaseUrl: "https://updates.example.test/releases/latest",
      env: { AGENT_RUNTIME_UPDATE_PUBLIC_KEY: fixture.keys.publicKey },
      fetchImpl: (_input, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      }),
      checkTimeoutMs: 5,
      checkRetries: 1,
    });
    const state = await timedOut.check();
    assert.equal(state.status, "error");
    assert.match(state.error, /timed out after 2 attempts/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("runtime package includes the verified dashboard shell used after an unsigned Mac update", async () => {
  const source = await fs.readFile(new URL("../scripts/package-agent-runtime.mjs", import.meta.url), "utf8");
  for (const file of [
    "agent/preload.cjs",
    "agent/token.js",
    "agent/dashboard.html",
    "agent/dashboard.css",
    "agent/dashboard-legal.css",
    "agent/dashboard-renderer.js",
    "agent/legal/privacy-policy.html",
    "agent/legal/terms.html",
  ]) assert.match(source, new RegExp(JSON.stringify(file).replaceAll(".", "\\.")));
});

test("runtime packaging declares the update type and validates its value", async () => {
  const source = await fs.readFile(new URL("../scripts/package-agent-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /AGENT_UPDATE_TYPE/);
  assert.match(source, /updateType/);
  assert.match(source, /either runtime or full/);
});

test("runtime package dependency discovery supports Windows npm shims", async () => {
  const source = await fs.readFile(new URL("../scripts/package-agent-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /const npmCommand = process\.platform === "win32" \? "npm\.cmd" : "npm"/);
  assert.match(source, /shell: process\.platform === "win32"/);
  assert.match(source, /String\(npmTree\.stdout \|\| ""\)/);
});
