import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const port = Number(process.env.LICENSE_SERVER_PORT || 4900);
const host = process.env.LICENSE_SERVER_HOST || "127.0.0.1";
const healthUrl = `http://${host}:${port}/v1/health`;

function findCommand(name, candidates = []) {
  const pathValue = String(process.env.PATH || "").split(":");
  for (const candidate of [name, ...candidates]) {
    if (candidate.includes("/")) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    for (const directory of pathValue) {
      const fullPath = `${directory}/${candidate}`;
      if (fs.existsSync(fullPath)) return fullPath;
    }
  }
  return "";
}

function waitForHealth(child) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error("The licensing server exited before its health endpoint became available."));
        return;
      }
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          clearInterval(timer);
          resolve();
          return;
        }
      } catch { /* retry while the server starts */ }
      if (Date.now() - started > 15_000) {
        clearInterval(timer);
        reject(new Error(`The licensing server did not become healthy at ${healthUrl}.`));
      }
    }, 250);
  });
}

async function main() {
  const tailscale = findCommand("tailscale", ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  if (!tailscale) throw new Error("Tailscale is not installed. Install the Tailscale app, sign in, and run this command again.");

  const server = spawn(process.execPath, ["license-server/index.js"], { stdio: "inherit", env: process.env });
  let tunnel;
  const stop = () => {
    if (tunnel && tunnel.exitCode === null) tunnel.kill("SIGTERM");
    if (server.exitCode === null) server.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await waitForHealth(server);
    tunnel = spawn(tailscale, ["funnel", "--bg", "--https=443", `http://${host}:${port}`], { stdio: "inherit", env: process.env });
    const tunnelStatus = await new Promise((resolve, reject) => {
      tunnel.once("error", reject);
      tunnel.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Tailscale Funnel failed${signal ? ` (${signal})` : ` with exit code ${code}`}.`)));
    });
    void tunnelStatus;
    let dnsName = "";
    try {
      const status = await new Promise((resolve, reject) => {
        const child = spawn(tailscale, ["status", "--json"], { env: process.env });
        let output = "";
        let error = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { error += chunk; });
        child.once("error", reject);
        child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(error || "Could not read Tailscale status.")));
      });
      dnsName = String(JSON.parse(status).Self?.DNSName || "").replace(/\.$/, "");
    } catch { /* Funnel can still be running; show the local endpoint below. */ }
    console.log("\nTailscale Funnel test mode is running.");
    console.log(`Local licensing server: ${healthUrl}`);
    console.log(`Public licensing server: ${dnsName ? `https://${dnsName}` : "check `tailscale funnel status`"}`);
    console.log("Keep this terminal running. The URL is stable for this Tailscale device; the licensing server must also run after reboot.");
    await new Promise((resolve) => server.once("exit", resolve));
  } finally {
    stop();
  }
}

main().catch((error) => {
  console.error(`NativeMedia Agent Tailscale test mode failed: ${error.message}`);
  process.exitCode = 1;
});
