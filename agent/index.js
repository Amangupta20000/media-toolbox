import os from "node:os";
import fs from "node:fs";
import path from "node:path";

function loadLocalEnvironment() {
  const filename = path.resolve(".env.local");
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

loadLocalEnvironment();

function defaultDataDirectory() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "MediaToolbox", "data");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "MediaToolbox", "data");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "MediaToolbox", "data");
}

process.env.DATA_DIR = defaultDataDirectory();
import("./server.js").then(({ startAgentServer }) => startAgentServer()).catch((error) => {
  console.error("NativeMedia Agent local agent failed to start:", error);
  process.exitCode = 1;
});
