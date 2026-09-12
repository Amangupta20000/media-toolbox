import fs from "node:fs/promises";
import path from "node:path";

const releaseDirectory = path.resolve(process.argv[2] || ".agent-build/release");
const entries = await fs.readdir(releaseDirectory);

function normalizedName(name) {
  if (name.startsWith("Media.Toolbox.Agent.Setup.")) {
    return `Media-Toolbox-Agent-Setup-${name.slice("Media.Toolbox.Agent.Setup.".length)}`;
  }
  if (name.startsWith("Media.Toolbox.Agent-")) {
    return `Media-Toolbox-Agent-${name.slice("Media.Toolbox.Agent-".length)}`;
  }
  return name;
}

const renames = entries
  .map((name) => ({ from: name, to: normalizedName(name) }))
  .filter(({ from, to }) => from !== to);

for (const { from, to } of renames) {
  const destination = path.join(releaseDirectory, to);
  try {
    await fs.access(destination);
    throw new Error(`Cannot normalize ${from}: destination already exists (${to})`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

for (const { from, to } of renames) {
  await fs.rename(path.join(releaseDirectory, from), path.join(releaseDirectory, to));
}

for (const name of entries.filter((entry) => /^latest.*\.yml$/.test(entry))) {
  const manifestPath = path.join(releaseDirectory, name);
  const content = await fs.readFile(manifestPath, "utf8");
  const normalizedContent = content
    .replaceAll("Media.Toolbox.Agent.Setup.", "Media-Toolbox-Agent-Setup-")
    .replaceAll("Media.Toolbox.Agent-", "Media-Toolbox-Agent-");
  if (normalizedContent !== content) {
    await fs.writeFile(manifestPath, normalizedContent);
  }
}

const normalizedEntries = new Set(await fs.readdir(releaseDirectory));
for (const name of (await fs.readdir(releaseDirectory)).filter((entry) => /^latest.*\.yml$/.test(entry))) {
  const content = await fs.readFile(path.join(releaseDirectory, name), "utf8");
  const referencedFiles = [
    ...content.matchAll(/^\s*(?:-\s+url|path):\s*['"]?([^'"\s]+)['"]?\s*$/gm),
  ].map((match) => match[1]);
  for (const referencedFile of referencedFiles) {
    if (!normalizedEntries.has(referencedFile)) {
      throw new Error(`${name} references missing release asset ${referencedFile}`);
    }
  }
}

console.log(`Normalized ${renames.length} agent release asset name(s) and validated updater manifests.`);
