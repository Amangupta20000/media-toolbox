import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { manifestPayload } from "../agent/runtime-update.cjs";

const sourceDirectory = path.resolve(process.argv[2] || ".agent-build");
const outputDirectory = path.resolve(process.argv[3] || path.join(sourceDirectory, "release"));
const platform = String(process.argv[4] || process.platform);
const arch = String(process.argv[5] || process.arch);
const privateKey = String(process.env.AGENT_RUNTIME_UPDATE_PRIVATE_KEY || "").trim();
if (!privateKey.includes("BEGIN PRIVATE KEY")) throw new Error("Set AGENT_RUNTIME_UPDATE_PRIVATE_KEY before creating a signed runtime update.");

const packageJson = JSON.parse(await fs.readFile(path.join(sourceDirectory, "package.json"), "utf8"));
const version = String(packageJson.version || "").replace(/^v/i, "");
if (!version) throw new Error("The staged agent package has no version.");

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-runtime-package-"));
const runtimeDirectory = path.join(temporaryDirectory, "runtime");
await fs.mkdir(runtimeDirectory, { recursive: true });

async function copy(relativeSource, relativeDestination = relativeSource) {
  const source = path.join(sourceDirectory, relativeSource);
  const destination = path.join(runtimeDirectory, relativeDestination);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

for (const file of ["agent/index.js", "agent/server.js", "agent/auth.js", "agent/tls.js", "agent/license-public-key.pem", "agent/license-server-url.txt", "agent/runtime-update-public-key.pem"]) {
  try { await copy(file); } catch (error) { if (!["agent/license-public-key.pem", "agent/license-server-url.txt"].includes(file) || error?.code !== "ENOENT") throw error; }
}
for (const directory of ["lib", "worker", "vendor/untrunc"]) await copy(directory);
await copy("components/processing-client.js");

const minimalPackage = {
  name: "media-toolbox-agent-runtime",
  version,
  private: true,
  type: "module",
  main: "agent/index.js",
};
await fs.writeFile(path.join(runtimeDirectory, "package.json"), `${JSON.stringify(minimalPackage, null, 2)}\n`);

// Ask npm for the production dependency closure. This keeps Electron and
// electron-builder out of the runtime update while preserving native modules
// needed by the local worker on the target platform.
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmTree = spawnSync(npmCommand, ["ls", "--omit=dev", "--all", "--parseable"], {
  cwd: sourceDirectory,
  encoding: "utf8",
  // Windows exposes npm as a .cmd shim. Node must invoke that shim through
  // the platform shell when this script is run from GitHub Actions.
  shell: process.platform === "win32",
});
if (npmTree.error) throw new Error(`Could not inspect production dependencies with ${npmCommand}: ${npmTree.error.message}`);
const nodeModulesRoot = path.join(sourceDirectory, "node_modules");
const npmTreeOutput = String(npmTree.stdout || "");
const modulePaths = npmTreeOutput.split(/\r?\n/).map((value) => value.trim()).filter((value) => value && value !== sourceDirectory && value.startsWith(`${nodeModulesRoot}${path.sep}`));
if (!modulePaths.length) throw new Error(`Could not determine production dependencies for the runtime package. ${String(npmTree.stderr || "")}`.trim());
for (const modulePath of modulePaths) {
  const relative = path.relative(nodeModulesRoot, modulePath);
  await fs.cp(modulePath, path.join(runtimeDirectory, "node_modules", relative), { recursive: true, force: true });
}

function crc32(buffer) {
  let value = 0xFFFFFFFF;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xEDB88320 & -(value & 1));
  }
  return (value ^ 0xFFFFFFFF) >>> 0;
}

async function filesIn(directory, prefix = "") {
  const entries = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) entries.push(...await filesIn(filename, relative));
    else if (entry.isFile()) entries.push({ filename, relative });
    // npm creates .bin symlinks inside dependency trees. They are not needed
    // by the runtime (native tools are resolved by their package paths), and
    // skipping them prevents symlinks from entering the signed archive.
    else if (entry.isSymbolicLink()) continue;
    else throw new Error(`Unsupported runtime package entry: ${relative}`);
  }
  return entries;
}

function dosDateTime() {
  return { date: 0x0021, time: 0 };
}

async function createZip(directory, destination) {
  const files = (await filesIn(directory)).sort((left, right) => left.relative.localeCompare(right.relative));
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const manifestFiles = [];
  for (const item of files) {
    const content = await fs.readFile(item.filename);
    const compressed = (await import("node:zlib")).deflateRawSync(content, { level: 9 });
    const method = compressed.length < content.length ? 8 : 0;
    const payload = method === 8 ? compressed : content;
    const name = Buffer.from(item.relative, "utf8");
    const digest = createHash("sha256").update(content).digest("hex");
    const mode = (await fs.stat(item.filename)).mode & 0o777;
    manifestFiles.push({ path: item.relative, size: content.length, sha256: digest, mode });
    const crc = crc32(content);
    const dateTime = dosDateTime();
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dateTime.time, 10);
    local.writeUInt16LE(dateTime.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, payload);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031E, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dateTime.time, 12);
    central.writeUInt16LE(dateTime.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(mode << 16, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + payload.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  await fs.writeFile(destination, Buffer.concat([...localParts, centralDirectory, end]), { mode: 0o644 });
  return manifestFiles;
}

await fs.mkdir(outputDirectory, { recursive: true });
const fileName = `Media-Toolbox-Agent-Runtime-${version}-${platform}-${arch}.zip`;
const archivePath = path.join(outputDirectory, fileName);
const files = await createZip(runtimeDirectory, archivePath);
const archive = await fs.readFile(archivePath);
const manifest = {
  schema: 1,
  version,
  platform,
  arch,
  fileName,
  url: fileName,
  sha256: createHash("sha256").update(archive).digest("hex"),
  size: archive.length,
  files,
  generatedAt: new Date().toISOString(),
};
manifest.signature = sign(null, Buffer.from(manifestPayload(manifest)), privateKey).toString("base64");
const manifestPath = path.join(outputDirectory, `agent-runtime-manifest-${platform}-${arch}.json`);
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
await fs.rm(temporaryDirectory, { recursive: true, force: true });
console.log(`Created signed runtime update ${archivePath}`);
console.log(`Created runtime update manifest ${manifestPath}`);
