import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function packageBinary(packageName) {
  try {
    const value = require(packageName);
    return value.path || value.default?.path || "";
  } catch {
    return "";
  }
}

function unpackedPath(filename) {
  const marker = `${path.sep}app.asar${path.sep}`;
  return filename.includes(marker) ? filename.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`) : filename;
}

function commandCandidates(command) {
  const candidates = [];
  if (command === "ffmpeg") {
    const filename = packageBinary("@ffmpeg-installer/ffmpeg");
    if (filename) candidates.push(unpackedPath(filename), filename);
  }
  if (command === "ffprobe") {
    const filename = packageBinary("@ffprobe-installer/ffprobe");
    if (filename) candidates.push(unpackedPath(filename), filename);
  }
  candidates.push(unpackedPath(command), command);
  return candidates.filter((value, index) => value && candidates.indexOf(value) === index);
}

async function executable(candidate) {
  if (!path.isAbsolute(candidate)) {
    try {
      const result = process.platform === "win32"
        ? await runCommand("where.exe", [candidate])
        : await runCommand("sh", ["-c", "command -v \"$1\" >/dev/null 2>&1", "sh", candidate]);
      return result.code === 0;
    } catch {
      return false;
    }
  }
  try {
    await fsp.access(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer;
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (options?.captureStdout !== false) stdout += text;
      options?.onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options?.onStderr?.(text);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr: timedOut ? `${stderr}\nCommand timed out after ${options.timeoutMs} ms.`.trim() : stderr,
      });
    });
    if (Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      }, options.timeoutMs);
    }
  });
}

export async function commandExists(command) {
  return Boolean(await resolveCommand(command));
}

export async function firstAvailable(commands) {
  for (const command of commands) {
    const resolved = await resolveCommand(command);
    if (resolved) return resolved;
  }
  return null;
}

export async function resolveCommand(command) {
  for (const candidate of commandCandidates(command)) {
    if (await executable(candidate)) return candidate;
  }
  return null;
}
