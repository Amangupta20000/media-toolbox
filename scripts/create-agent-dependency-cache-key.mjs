import fs from "node:fs/promises";
import path from "node:path";

const inputPath = path.resolve(process.argv[2] || "agent/package-lock.json");
const outputPath = path.resolve(process.argv[3] || ".agent-dependency-cache.json");
const lockfile = JSON.parse(await fs.readFile(inputPath, "utf8"));

// The package version changes on every installer release, but it does not
// change the dependency tree. Keep it out of the cache fingerprint so a
// version-only release can reuse the native Electron dependency cache.
delete lockfile.version;
if (lockfile.packages?.[""] && typeof lockfile.packages[""] === "object") {
  delete lockfile.packages[""].version;
}

await fs.writeFile(outputPath, `${JSON.stringify(lockfile)}\n`);
