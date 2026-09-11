import { spawn } from "node:child_process";
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

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];
let stopping = false;

function start(command, args) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  children.push(child);
  return child;
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 250);
}

const web = start(npmCommand, ["run", "dev:web"]);
const worker = start(process.execPath, ["worker/index.js"]);

for (const child of [web, worker]) {
  child.on("error", () => stop(1));
  child.on("exit", (code, signal) => {
    if (!stopping) stop(code || 1);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
