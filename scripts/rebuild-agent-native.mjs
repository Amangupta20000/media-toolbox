import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = path.resolve(process.argv[2] || projectDirectory);
const require = createRequire(path.join(packageDirectory, "package.json"));

const electronPackage = JSON.parse(
  await fs.readFile(path.join(packageDirectory, "node_modules", "electron", "package.json"), "utf8"),
);
const electronVersion = electronPackage.version;
const rebuildEntry = require.resolve("@electron/rebuild");
const rebuildCli = path.join(path.dirname(rebuildEntry), "cli.js");

console.log(`Rebuilding native agent dependencies in ${packageDirectory} for Electron ${electronVersion}.`);

const child = spawn(process.execPath, [rebuildCli, "--version", electronVersion, "--parallel"], {
  cwd: packageDirectory,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Could not start electron-rebuild: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`electron-rebuild exited with signal ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
