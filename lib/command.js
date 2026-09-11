import { spawn } from "node:child_process";

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
  try {
    const result = await runCommand("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", command]);
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function firstAvailable(commands) {
  for (const command of commands) {
    if (await commandExists(command)) return command;
  }
  return null;
}
