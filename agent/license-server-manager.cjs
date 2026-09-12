const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { spawn: defaultSpawn } = require("node:child_process");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4900;
const DEFAULT_DATA_DIR = "/Volumes/Sandisk Exf/MediaToolboxLicensing";
const DEFAULT_MOUNT_PATH = "/Volumes/Sandisk Exf";
const HEALTH_TIMEOUT_MS = 1500;
const START_TIMEOUT_MS = 15000;

function isAlive(child) {
  return Boolean(child && child.exitCode === null && !child.killed);
}

function findNode22Executable(homeDirectory = process.env.HOME || "") {
  const versionsDirectory = path.join(homeDirectory, ".nvm", "versions", "node");
  try {
    const version = fs.readdirSync(versionsDirectory)
      .filter((value) => /^v22\./.test(value))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
    const executable = version && path.join(versionsDirectory, version, "bin", "node");
    return executable && fs.existsSync(executable) ? executable : "";
  } catch {
    return "";
  }
}

function probeHealth(url, { httpModule = http, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(value));
    };
    let request;
    try {
      request = httpModule.get(url, { timeout: timeoutMs }, (response) => {
        response.resume?.();
        finish(response.statusCode === 200);
      });
      request.once?.("error", () => finish(false));
      request.once?.("timeout", () => {
        request.destroy?.();
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

function probeEndpoint(url, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return Promise.resolve(false);
    return probeHealth(url, { httpModule: parsed.protocol === "https:" ? https : http, timeoutMs });
  } catch {
    return Promise.resolve(false);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createLicenseServerManager({
  app,
  moduleDirectory = __dirname,
  dataDirectory = process.env.LICENSE_DATA_DIR || DEFAULT_DATA_DIR,
  mountPath = DEFAULT_MOUNT_PATH,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  nodeExecutable = "",
  electronExecutable = process.execPath,
  useElectronRuntime = false,
  spawnImpl = defaultSpawn,
  existsSync = fs.existsSync,
  healthCheck = (url) => probeHealth(url),
  publicHealthCheck = (url) => probeEndpoint(url),
  logger = console,
} = {}) {
  let child = null;
  let lastError = "";
  const entryPath = path.join(moduleDirectory, "..", "license-server", "index.js");
  const url = `http://${host}:${port}`;
  let ownerMarkerPath = "";
  try {
    const userDataPath = app?.getPath?.("userData");
    if (userDataPath) ownerMarkerPath = path.join(userDataPath, "license-server-owner.marker");
  } catch {
    ownerMarkerPath = "";
  }

  function publicUrl() {
    return String(process.env.LICENSE_SERVER_PUBLIC_URL || process.env.AGENT_LICENSE_SERVER_URL || process.env.NEXT_PUBLIC_LICENSE_SERVER_URL || "").trim().replace(/\/$/, "");
  }

  function storageState() {
    const ssdMounted = Boolean(existsSync(mountPath));
    const ownerMarker = Boolean(ownerMarkerPath && existsSync(ownerMarkerPath));
    return {
      dataDir: dataDirectory,
      ssdMounted,
      storageReady: Boolean(existsSync(dataDirectory)),
      // The SSD is the first-run owner signal. After the owner starts the
      // service once, the marker keeps the owner controls discoverable even
      // while the SSD is temporarily disconnected. Client installations do
      // not show an SSD prompt merely because they contain the server code.
      ownerConfigured: ssdMounted || ownerMarker,
    };
  }

  async function getState() {
    const publicEndpoint = publicUrl();
    const [healthy, publicHealthy] = await Promise.all([
      healthCheck(`${url}/v1/health`),
      publicEndpoint ? publicHealthCheck(`${publicEndpoint}/v1/health`) : Promise.resolve(null),
    ]);
    const storage = storageState();
    const state = {
      available: Boolean(existsSync(entryPath)),
      healthy,
      running: healthy,
      publicHealthy,
      managed: isAlive(child),
      url,
      publicUrl: publicEndpoint,
      ...storage,
      runtime: useElectronRuntime ? "packaged Electron runtime" : (nodeExecutable ? nodeExecutable : "Node 22 required"),
      error: lastError
        || (storage.ownerConfigured && !storage.ssdMounted ? "Connect the licensing SSD before starting the server."
          : healthy && publicEndpoint && publicHealthy === false ? "The local licensing server is running, but its public HTTPS endpoint could not be reached. Check Tailscale Funnel and the public URL."
            : ""),
    };
    return state;
  }

  function rememberOwnerMachine() {
    if (!ownerMarkerPath) return;
    try {
      fs.mkdirSync(path.dirname(ownerMarkerPath), { recursive: true });
      fs.writeFileSync(ownerMarkerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
    } catch (error) {
      logger.warn?.(`The licensing-server owner marker could not be saved: ${error.message}`);
    }
  }

  async function waitForHealth(childProcess) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < START_TIMEOUT_MS) {
      if (childProcess && childProcess.exitCode !== null) {
        throw new Error(lastError || "The licensing server exited before becoming healthy.");
      }
      if (await healthCheck(`${url}/v1/health`)) return;
      await wait(250);
    }
    throw new Error(`The licensing server did not become healthy at ${url}.`);
  }

  async function start() {
    const current = await getState();
    if (current.healthy) return { ...current, started: false, message: "The licensing server is already running." };
    if (!current.ssdMounted) throw new Error("Connect the Sandisk Exf licensing SSD before starting the server.");
    if (!current.available) throw new Error("This agent release does not include the licensing server runtime.");
    if (child && isAlive(child)) {
      await waitForHealth(child);
      return { ...(await getState()), started: false, message: "The licensing server is already starting." };
    }

    lastError = "";
    const environment = {
      ...process.env,
      LICENSE_SERVER_HOST: host,
      LICENSE_SERVER_PORT: String(port),
      LICENSE_DATA_DIR: dataDirectory,
      NODE_ENV: "production",
    };
    const command = useElectronRuntime ? electronExecutable : nodeExecutable;
    if (!command) throw new Error("Node 22 was not found. Open a new Terminal after installing Node 22, then try again.");
    const args = [entryPath];
    if (useElectronRuntime) environment.ELECTRON_RUN_AS_NODE = "1";

    const nextChild = spawnImpl(command, args, {
      cwd: path.resolve(moduleDirectory, ".."),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child = nextChild;
    nextChild.stdout?.on?.("data", (chunk) => logger.log?.(String(chunk).trim()));
    nextChild.stderr?.on?.("data", (chunk) => {
      const value = String(chunk).trim();
      if (value) lastError = value.slice(-1000);
      logger.warn?.(value);
    });
    nextChild.once?.("error", (error) => {
      lastError = error instanceof Error ? error.message : String(error);
    });
    nextChild.once?.("exit", (code, signal) => {
      if (child !== nextChild) return;
      child = null;
      if (code && !lastError) lastError = `The licensing server exited with code ${code}${signal ? ` (${signal})` : ""}.`;
    });

    try {
      await waitForHealth(nextChild);
      rememberOwnerMachine();
      return { ...(await getState()), started: true, message: "The licensing server is running." };
    } catch (error) {
      if (isAlive(nextChild)) nextChild.kill?.("SIGTERM");
      throw error;
    }
  }

  async function stop() {
    if (!child || !isAlive(child)) return getState();
    const stopping = child;
    stopping.kill?.("SIGTERM");
    const startedAt = Date.now();
    while (isAlive(stopping) && Date.now() - startedAt < 3000) await wait(50);
    if (isAlive(stopping)) stopping.kill?.("SIGKILL");
    return getState();
  }

  return { getState, start, stop, entryPath, findNode22Executable: () => findNode22Executable(app?.getPath?.("home") || process.env.HOME || "") };
}

module.exports = { createLicenseServerManager, findNode22Executable, probeHealth };
