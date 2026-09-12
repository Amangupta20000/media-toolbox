import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagingDirectory = path.join(projectDirectory, ".agent-build");

await fs.rm(stagingDirectory, { recursive: true, force: true });
await fs.mkdir(stagingDirectory, { recursive: true });

async function copy(relativeSource, relativeDestination = relativeSource) {
  const source = path.join(projectDirectory, relativeSource);
  const destination = path.join(stagingDirectory, relativeDestination);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, force: true });
}

for (const directory of ["agent", "lib", "worker", "license-server", "vendor/untrunc"]) {
  await copy(directory);
}
await copy("components/processing-client.js");
await copy("build/app-update.yml");
await copy("electron-builder.yml");
await copy("agent/package.json", "package.json");
await copy("agent/package-lock.json", "package-lock.json");

for (const filename of ["license-public-key.pem", "license-server-url.txt"]) {
  const stagedFile = path.join(stagingDirectory, "agent", filename);
  try {
    await fs.access(stagedFile);
  } catch {
    throw new Error(`The staged agent is missing agent/${filename}. Run the embedding step before packaging.`);
  }
}

console.log(`Staged the agent-only package at ${stagingDirectory}`);
