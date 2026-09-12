const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID, verify } = require("node:crypto");
const { Readable } = require("node:stream");

const RUNTIME_MANIFEST_SCHEMA = 1;
const RUNTIME_MANIFEST_FILE = "runtime-manifest.json";
const RUNTIME_MANIFEST_PREFIX = "agent-runtime-manifest-";
const RUNTIME_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const RUNTIME_MAX_FILES_BYTES = 1024 * 1024 * 1024;

function safeVersion(value) {
  const normalized = String(value || "").trim().replace(/^v/i, "");
  return /^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : "0.0.0";
}

function versionParts(value) {
  const [core, prerelease = ""] = safeVersion(value).split("-", 2);
  return { core: core.split(".").map((item) => Number(item) || 0), prerelease };
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const difference = (a.core[index] || 0) - (b.core[index] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function manifestPayload(manifest) {
  const files = Array.isArray(manifest?.files)
    ? manifest.files.map((entry) => ({
      path: String(entry.path || ""),
      size: Number(entry.size),
      sha256: String(entry.sha256 || "").toLowerCase(),
      mode: Number(entry.mode) || 0,
    })).sort((left, right) => left.path.localeCompare(right.path))
    : [];
  return JSON.stringify({
    schema: RUNTIME_MANIFEST_SCHEMA,
    version: safeVersion(manifest?.version),
    platform: String(manifest?.platform || ""),
    arch: String(manifest?.arch || ""),
    fileName: String(manifest?.fileName || ""),
    url: String(manifest?.url || ""),
    sha256: String(manifest?.sha256 || "").toLowerCase(),
    size: Number(manifest?.size),
    files,
    generatedAt: String(manifest?.generatedAt || ""),
  });
}

function safeRelativePath(value) {
  const input = String(value || "");
  if (!input || input.includes("\0")) return "";
  const normalized = input.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return "";
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return "";
  return parts.join("/");
}

function safeFileName(value) {
  const name = String(value || "");
  return /^[A-Za-z0-9._-]+\.zip$/.test(name) ? name : "";
}

function validateManifestShape(manifest, { platform = process.platform, arch = process.arch } = {}) {
  if (!manifest || Number(manifest.schema) !== RUNTIME_MANIFEST_SCHEMA) throw new Error("The runtime update manifest version is unsupported.");
  if (safeVersion(manifest.version) !== String(manifest.version || "").replace(/^v/i, "")) throw new Error("The runtime update version is invalid.");
  if (String(manifest.platform) !== platform || String(manifest.arch) !== arch) throw new Error("The runtime update is for a different platform or CPU architecture.");
  if (!safeFileName(manifest.fileName) || manifest.url !== manifest.fileName) throw new Error("The runtime update asset name is invalid.");
  if (!/^[a-f0-9]{64}$/i.test(String(manifest.sha256 || ""))) throw new Error("The runtime update checksum is invalid.");
  if (!Number.isSafeInteger(Number(manifest.size)) || Number(manifest.size) <= 0 || Number(manifest.size) > RUNTIME_MAX_ARCHIVE_BYTES) throw new Error("The runtime update size is invalid.");
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error("The runtime update file list is missing.");
  const seen = new Set();
  let total = 0;
  for (const entry of manifest.files) {
    const relativePath = safeRelativePath(entry?.path);
    if (!relativePath || seen.has(relativePath)) throw new Error("The runtime update contains an unsafe or duplicate file path.");
    seen.add(relativePath);
    if (!Number.isSafeInteger(Number(entry.size)) || Number(entry.size) < 0 || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ""))) throw new Error("The runtime update contains an invalid file checksum.");
    total += Number(entry.size);
    if (total > RUNTIME_MAX_FILES_BYTES) throw new Error("The runtime update is too large after extraction.");
  }
  if (!seen.has("agent/server.js") || !seen.has("package.json")) throw new Error("The runtime update is incomplete.");
}

function verifyRuntimeManifest(manifest, publicKey, options = {}) {
  validateManifestShape(manifest, options);
  if (!String(publicKey || "").includes("BEGIN PUBLIC KEY")) throw new Error("The runtime update public key is not configured.");
  let signature;
  try { signature = Buffer.from(String(manifest.signature || ""), "base64"); } catch { signature = Buffer.alloc(0); }
  if (!signature.length || !verify(null, Buffer.from(manifestPayload(manifest)), publicKey, signature)) throw new Error("The runtime update signature is invalid.");
  return true;
}

function readPublicKey({ moduleDirectory = __dirname, env = process.env } = {}) {
  const configured = String(env.AGENT_RUNTIME_UPDATE_PUBLIC_KEY || "").trim();
  if (configured.includes("BEGIN PUBLIC KEY")) return configured;
  for (const candidate of [
    String(env.AGENT_RUNTIME_UPDATE_PUBLIC_KEY_FILE || ""),
    path.join(moduleDirectory, "runtime-update-public-key.pem"),
  ].filter(Boolean)) {
    try {
      const value = fs.readFileSync(candidate, "utf8");
      if (value.includes("BEGIN PUBLIC KEY")) return value;
    } catch { /* Try the next candidate. */ }
  }
  return "";
}

function hashFile(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filename);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function within(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

async function verifyRuntimeDirectory(directory, manifest, publicKey, options = {}) {
  verifyRuntimeManifest(manifest, publicKey, options);
  const root = path.resolve(directory);
  let total = 0;
  for (const entry of manifest.files) {
    const relativePath = safeRelativePath(entry.path);
    const filename = path.resolve(root, ...relativePath.split("/"));
    if (!within(root, filename)) throw new Error("The runtime update contains a path outside its directory.");
    const stat = await fsp.lstat(filename).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`The runtime update is missing ${relativePath}.`);
    if (stat.size !== Number(entry.size)) throw new Error(`The runtime update size is incorrect for ${relativePath}.`);
    const digest = await hashFile(filename);
    if (digest !== String(entry.sha256).toLowerCase()) throw new Error(`The runtime update checksum is incorrect for ${relativePath}.`);
    total += stat.size;
  }
  if (total > RUNTIME_MAX_FILES_BYTES) throw new Error("The runtime update is too large after extraction.");
  return true;
}

function zipPath(name, root) {
  const relativePath = safeRelativePath(name);
  if (!relativePath) throw new Error("The ZIP archive contains an unsafe path.");
  const filename = path.resolve(root, ...relativePath.split("/"));
  if (!within(root, filename)) throw new Error("The ZIP archive contains a path outside its directory.");
  return { relativePath, filename };
}

function findEndOfCentralDirectory(buffer) {
  const start = Math.max(0, buffer.length - 0xFFFF - 22);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("The runtime update is not a valid ZIP archive.");
}

async function extractZipArchive(archivePath, destination) {
  const archive = await fsp.readFile(archivePath);
  if (!archive.length || archive.length > RUNTIME_MAX_ARCHIVE_BYTES) throw new Error("The runtime update archive is too large.");
  const end = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  const centralOffset = archive.readUInt32LE(end + 16);
  if (entryCount > 10000 || centralOffset + centralSize > archive.length) throw new Error("The runtime update ZIP directory is invalid.");
  await fsp.mkdir(destination, { recursive: true });
  const seen = new Set();
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("The runtime update ZIP entry is invalid.");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > archive.length) throw new Error("The runtime update ZIP entry is truncated.");
    const name = archive.subarray(offset + 46, nameEnd).toString("utf8");
    offset = nameEnd + extraLength + commentLength;
    if (flags & 0x1) throw new Error("Encrypted runtime updates are not supported.");
    const isDirectory = name.endsWith("/");
    if (isDirectory) {
      const relativePath = safeRelativePath(name.slice(0, -1));
      if (relativePath) await fsp.mkdir(path.resolve(destination, ...relativePath.split("/")), { recursive: true });
      continue;
    }
    const { relativePath, filename } = zipPath(name, destination);
    if (seen.has(relativePath)) throw new Error("The runtime update ZIP contains duplicate paths.");
    seen.add(relativePath);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xF000) === 0xA000) throw new Error("Symbolic links are not allowed in runtime updates.");
    if (uncompressedSize > RUNTIME_MAX_FILES_BYTES || compressedSize > archive.length) throw new Error("The runtime update ZIP entry is too large.");
    total += uncompressedSize;
    if (total > RUNTIME_MAX_FILES_BYTES) throw new Error("The runtime update is too large after extraction.");
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("The runtime update local ZIP entry is invalid.");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > archive.length) throw new Error("The runtime update ZIP data is truncated.");
    const compressed = archive.subarray(dataStart, dataEnd);
    let content;
    if (method === 0) content = Buffer.from(compressed);
    else if (method === 8) {
      const zlib = require("node:zlib");
      content = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(uncompressedSize, RUNTIME_MAX_FILES_BYTES - total)) });
    } else throw new Error("The runtime update uses an unsupported ZIP compression method.");
    if (content.length !== uncompressedSize) throw new Error("The runtime update ZIP entry size is incorrect.");
    await fsp.mkdir(path.dirname(filename), { recursive: true });
    await fsp.writeFile(filename, content, { flag: "wx" });
    if (unixMode & 0o111) await fsp.chmod(filename, unixMode & 0o777).catch(() => undefined);
  }
  return { files: seen.size, bytes: total, paths: [...seen] };
}

function runtimeDirectory(userDataPath) {
  return path.join(userDataPath, "agent-runtime");
}

function pendingRuntimeDirectory(userDataPath) {
  return path.join(userDataPath, "agent-runtime-pending");
}

function installedManifest(userDataPath) {
  return path.join(runtimeDirectory(userDataPath), RUNTIME_MANIFEST_FILE);
}

async function readInstalledRuntime({ userDataPath, moduleDirectory = __dirname, env = process.env } = {}) {
  const publicKey = readPublicKey({ moduleDirectory, env });
  if (!publicKey) return null;
  const directory = runtimeDirectory(userDataPath);
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(installedManifest(userDataPath), "utf8")); } catch { return null; }
  try {
    await verifyRuntimeDirectory(directory, manifest, publicKey);
    return { directory, manifest };
  } catch {
    return null;
  }
}

function publicState(state) {
  const { manifest: _manifest, publicKey: _publicKey, pendingDirectory: _pendingDirectory, ...value } = state;
  return { ...value };
}

function manifestUrlFor({ latestReleaseUrl, platform, arch, env = process.env }) {
  const configured = String(env.AGENT_RUNTIME_UPDATE_MANIFEST_URL || "").trim();
  if (configured) return configured;
  const base = String(latestReleaseUrl || "").replace(/\/$/, "");
  return `${base}/download/${RUNTIME_MANIFEST_PREFIX}${platform}-${arch}.json`;
}

function assetUrlFor(manifestUrl, manifest) {
  const url = new URL(String(manifest.url), manifestUrl);
  const origin = new URL(manifestUrl).origin;
  if (url.origin !== origin || url.protocol !== "https:") throw new Error("The runtime update asset must use the manifest's HTTPS origin.");
  return url.href;
}

function responseError(response, label) {
  if (response?.ok) return null;
  return new Error(`${label} returned HTTP ${response?.status || "an unknown error"}.`);
}

function createRuntimeUpdater({
  userDataPath,
  moduleDirectory = __dirname,
  latestReleaseUrl,
  platform = process.platform,
  arch = process.arch,
  getCurrentVersion = () => "0.0.0",
  fetchImpl = globalThis.fetch,
  onState = () => {},
  env = process.env,
} = {}) {
  const publicKey = readPublicKey({ moduleDirectory, env });
  const state = {
    kind: "runtime",
    status: publicKey ? "idle" : "unavailable",
    currentVersion: safeVersion(getCurrentVersion()),
    runtimeVersion: null,
    version: null,
    progress: 0,
    checkedAt: null,
    error: publicKey ? "" : "Verified runtime updates are not configured in this agent build.",
  };
  let manifest;
  let manifestUrl = manifestUrlFor({ latestReleaseUrl, platform, arch, env });
  let pendingDirectory = pendingRuntimeDirectory(userDataPath);

  function publish(next) {
    Object.assign(state, next, { currentVersion: safeVersion(getCurrentVersion()) });
    onState(publicState(state));
    return publicState(state);
  }

  async function currentInstalledVersion() {
    const installed = await readInstalledRuntime({ userDataPath, moduleDirectory, env });
    state.runtimeVersion = installed?.manifest?.version || null;
    return installed?.manifest?.version || state.currentVersion;
  }

  async function readPending() {
    try {
      const pendingManifest = JSON.parse(await fsp.readFile(path.join(pendingDirectory, RUNTIME_MANIFEST_FILE), "utf8"));
      await verifyRuntimeDirectory(pendingDirectory, pendingManifest, publicKey, { platform, arch });
      return pendingManifest;
    } catch {
      return null;
    }
  }

  async function check() {
    if (!publicKey) return publish({ status: "unavailable", error: "Verified runtime updates are not configured in this agent build.", checkedAt: new Date().toISOString() });
    if (typeof fetchImpl !== "function") return publish({ status: "error", error: "This agent cannot download runtime updates.", checkedAt: new Date().toISOString() });
    publish({ status: "checking", error: "", checkedAt: new Date().toISOString(), progress: 0 });
    try {
      const response = await fetchImpl(manifestUrl, { cache: "no-store", headers: { Accept: "application/json" } });
      const responseFailure = responseError(response, "The runtime update manifest");
      if (responseFailure) throw responseFailure;
      const nextManifest = await response.json();
      verifyRuntimeManifest(nextManifest, publicKey, { platform, arch });
      manifestUrl = manifestUrlFor({ latestReleaseUrl, platform, arch, env });
      const installedVersion = await currentInstalledVersion();
      manifest = nextManifest;
      const pendingManifest = await readPending();
      if (pendingManifest && compareVersions(pendingManifest.version, installedVersion) > 0) {
        manifest = pendingManifest;
        return publish({ status: "downloaded", version: pendingManifest.version, runtimeVersion: installedVersion, error: "", progress: 100, checkedAt: new Date().toISOString() });
      }
      if (compareVersions(nextManifest.version, installedVersion) <= 0) return publish({ status: "up-to-date", version: nextManifest.version, runtimeVersion: installedVersion, error: "", progress: 0, checkedAt: new Date().toISOString() });
      return publish({ status: "available", version: nextManifest.version, runtimeVersion: installedVersion, error: "", progress: 0, checkedAt: new Date().toISOString() });
    } catch (error) {
      return publish({ status: "error", error: error instanceof Error ? error.message : "The runtime update could not be checked.", checkedAt: new Date().toISOString() });
    }
  }

  async function download() {
    if (!publicKey) throw new Error("Verified runtime updates are not configured in this agent build.");
    if (state.status !== "available" && state.status !== "error") throw new Error("Check for a runtime update before downloading it.");
    if (!manifest) await check();
    if (!manifest || state.status !== "available") throw new Error(state.error || "There is no runtime update ready to download.");
    const assetUrl = assetUrlFor(manifestUrl, manifest);
    const temporaryArchive = path.join(userDataPath, `.agent-runtime-${randomUUID()}.zip`);
    publish({ status: "downloading", version: manifest.version, progress: 0, error: "" });
    try {
      const response = await fetchImpl(assetUrl, { cache: "no-store", headers: { Accept: "application/zip" } });
      const responseFailure = responseError(response, "The runtime update download");
      if (responseFailure) throw responseFailure;
      if (!response.body) throw new Error("The runtime update download had no body.");
      const totalBytes = Number(response.headers?.get?.("content-length") || 0);
      if (totalBytes > RUNTIME_MAX_ARCHIVE_BYTES) throw new Error("The runtime update archive is too large.");
      await fsp.mkdir(userDataPath, { recursive: true });
      const handle = await fsp.open(temporaryArchive, "w", 0o600);
      let downloaded = 0;
      const stream = Readable.fromWeb(response.body);
      try {
        for await (const chunk of stream) {
          downloaded += chunk.length;
          if (downloaded > RUNTIME_MAX_ARCHIVE_BYTES) throw new Error("The runtime update archive is too large.");
          await handle.write(chunk);
          publish({ status: "downloading", progress: totalBytes ? Math.floor(downloaded / totalBytes * 100) : 0, version: manifest.version });
        }
      } finally { await handle.close(); }
      const digest = await hashFile(temporaryArchive);
      if (digest !== String(manifest.sha256).toLowerCase()) throw new Error("The runtime update SHA-256 checksum is invalid.");
      const archiveStat = await fsp.stat(temporaryArchive);
      if (archiveStat.size !== Number(manifest.size)) throw new Error("The runtime update archive size is invalid.");
      await fsp.rm(pendingDirectory, { recursive: true, force: true });
      const extracted = await extractZipArchive(temporaryArchive, pendingDirectory);
      const expectedPaths = new Set(manifest.files.map((entry) => safeRelativePath(entry.path)));
      if (extracted.paths.length !== expectedPaths.size || extracted.paths.some((relativePath) => !expectedPaths.has(relativePath))) {
        throw new Error("The runtime update archive does not match its signed file list.");
      }
      await fsp.writeFile(path.join(pendingDirectory, RUNTIME_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await verifyRuntimeDirectory(pendingDirectory, manifest, publicKey, { platform, arch });
      return publish({ status: "downloaded", version: manifest.version, progress: 100, error: "", checkedAt: new Date().toISOString() });
    } catch (error) {
      await fsp.rm(pendingDirectory, { recursive: true, force: true }).catch(() => undefined);
      return publish({ status: "error", error: error instanceof Error ? error.message : "The runtime update could not be downloaded.", checkedAt: new Date().toISOString() });
    } finally { await fsp.rm(temporaryArchive, { force: true }).catch(() => undefined); }
  }

  async function install() {
    const pendingManifest = await readPending();
    if (!pendingManifest) throw new Error("The verified runtime update is not ready to install.");
    const activeDirectory = runtimeDirectory(userDataPath);
    const backupDirectory = path.join(userDataPath, `.agent-runtime-backup-${randomUUID()}`);
    await fsp.mkdir(userDataPath, { recursive: true });
    let movedActive = false;
    try {
      await fsp.rename(activeDirectory, backupDirectory);
      movedActive = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      await fsp.rename(pendingDirectory, activeDirectory);
      await verifyRuntimeDirectory(activeDirectory, pendingManifest, publicKey, { platform, arch });
    } catch (error) {
      await fsp.rm(activeDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (movedActive) await fsp.rename(backupDirectory, activeDirectory).catch(() => undefined);
      throw error;
    }
    await fsp.rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
    manifest = pendingManifest;
    return publish({ status: "installed", version: pendingManifest.version, runtimeVersion: pendingManifest.version, progress: 100, error: "" });
  }

  return {
    getState: () => publicState(state),
    check,
    download,
    install,
    getManifestUrl: () => manifestUrl,
    getRuntimeDirectory: () => runtimeDirectory(userDataPath),
  };
}

module.exports = {
  RUNTIME_MANIFEST_FILE,
  RUNTIME_MANIFEST_PREFIX,
  compareVersions,
  createRuntimeUpdater,
  extractZipArchive,
  manifestPayload,
  readPublicKey,
  readInstalledRuntime,
  verifyRuntimeDirectory,
  verifyRuntimeManifest,
};
