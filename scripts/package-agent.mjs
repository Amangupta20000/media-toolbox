import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagingDirectory = path.join(projectDirectory, ".agent-build");
const scriptDirectory = path.join(projectDirectory, "scripts");
const packageArguments = process.argv.slice(2);

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} exited with signal ${signal}.`));
      else if (code !== 0) reject(new Error(`${command} exited with code ${code ?? 1}.`));
      else resolve();
    });
  });
}

await run(process.execPath, [path.join(scriptDirectory, "stage-agent-package.mjs")], projectDirectory);
await run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--prefer-offline", "--no-audit", "--no-fund"], stagingDirectory);
await run(process.execPath, [path.join(scriptDirectory, "rebuild-agent-native.mjs"), stagingDirectory], projectDirectory);
await run(
  process.execPath,
  [path.join(stagingDirectory, "node_modules", "electron-builder", "cli.js"), "--config", "electron-builder.yml", ...packageArguments],
  stagingDirectory,
);

console.log(`Agent package created in ${path.join(stagingDirectory, "release")}`);
