const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { execFile: defaultExecFile, spawn: defaultSpawn } = require("node:child_process");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4900;
const DEFAULT_DATA_DIR = "/Volumes/Sandisk Exf/MediaToolboxLicensing";
const DEFAULT_MOUNT_PATH = "/Volumes/Sandisk Exf";
const HEALTH_TIMEOUT_MS = 1500;
const START_TIMEOUT_MS = 15000;
const AUTO_START_INTERVAL_MS = 5000;
const DEFAULT_TAILSCALE_APP_PATH = "/Applications/Tailscale.app";
const TAILSCALE_PROCESS_NAME = "Tailscale";
const TAILSCALE_PGREP_PATH = "/usr/bin/pgrep";
const TAILSCALE_OPEN_PATH = "/usr/bin/open";
const DEFAULT_LICENSE_PROXY_URL = "https://media-toolbox-woad.vercel.app/api/license";

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

function runExecFile(execFileImpl, file, args) {
  return new Promise((resolve, reject) => {
    try {
      execFileImpl(file, args, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error: error || null,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      });
    } catch (error) {
      reject(error);
    }
  });
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
  resourcesPath = process.resourcesPath || "",
  autoStartIntervalMs = AUTO_START_INTERVAL_MS,
  spawnImpl = defaultSpawn,
  execFileImpl = defaultExecFile,
  existsSync = fs.existsSync,
  platform = process.platform,
  tailscaleAppPath = DEFAULT_TAILSCALE_APP_PATH,
  tailscaleRunningCheck = null,
  tailscaleOpen = null,
  healthCheck = (url) => probeHealth(url),
  publicHealthCheck = (url) => probeEndpoint(url),
  publicProxyHealthCheck = null,
  publicProxyUrl = process.env.AGENT_LICENSE_SERVER_PROXY_URL || DEFAULT_LICENSE_PROXY_URL,
  tailscaleFunnelConfigure = null,
  logger = console,
} = {}) {
  let child = null;
  let lastError = "";
  let autoStartTimer = null;
  let autoStartRun = null;
  let startRun = null;
  let manuallyStopped = false;
  let publicHealthyBeforeFailure = null;
  let consecutivePublicFailures = 0;
  const checkTailscaleRunning = tailscaleRunningCheck || (async () => {
    const result = await runExecFile(execFileImpl, TAILSCALE_PGREP_PATH, ["-x", TAILSCALE_PROCESS_NAME]);
    return result.ok;
  });
  const openTailscaleApp = tailscaleOpen || (async () => {
    const result = await runExecFile(execFileImpl, TAILSCALE_OPEN_PATH, ["-a", "Tailscale"]);
    if (!result.ok) {
      throw result.error || new Error(result.stderr || "The Tailscale app could not be opened.");
    }
  });
  // A packaged Electron app cannot spawn a script through an app.asar path:
  // the archive is readable by Electron but app.asar itself is not a real
  // directory to the child process. The builder copies this runtime to the
  // real Resources directory, so use that path for packaged agents.
  const entryPath = resourcesPath
    ? path.join(resourcesPath, "license-server", "index.js")
    : path.join(moduleDirectory, "..", "license-server", "index.js");
  const url = `http://${host}:${port}`;
  let ownerMarkerPath = "";
  try {
    const userDataPath = app?.getPath?.("userData");
    if (userDataPath) ownerMarkerPath = path.join(userDataPath, "license-server-owner.marker");
  } catch {
    ownerMarkerPath = "";
  }

  function publicUrl() {
    let packagedUrl = "";
    if (process.resourcesPath || process.env.AGENT_PACKAGED_CONFIG === "1") {
      try {
        packagedUrl = fs.readFileSync(path.join(moduleDirectory, "license-server-url.txt"), "utf8").trim();
      } catch {
        packagedUrl = "";
      }
    }
    return String(process.env.LICENSE_SERVER_PUBLIC_URL || process.env.AGENT_LICENSE_SERVER_URL || process.env.NEXT_PUBLIC_LICENSE_SERVER_URL || packagedUrl).trim().replace(/\/$/, "");
  }

  function spawnWorkingDirectory() {
    // In a packaged Electron app, moduleDirectory is inside app.asar. The
    // archive is readable by Electron but cannot be used as a child-process
    // cwd, which causes spawn() to fail with ENOTDIR after a manual restart.
    // Electron's Resources directory is a real directory and is suitable for
    // the server process. Source/Node development continues to use the
    // repository root.
    if (resourcesPath) {
      try {
        if (fs.statSync(resourcesPath).isDirectory()) return resourcesPath;
      } catch { /* fall back to the source package directory */ }
    }
    const packageDirectory = path.resolve(moduleDirectory, "..");
    try {
      if (fs.statSync(packageDirectory).isDirectory()) return packageDirectory;
    } catch { /* use the current directory as a final safe fallback */ }
    return process.cwd();
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

  async function getTailscaleState() {
    if (platform !== "darwin") {
      return {
        supported: false,
        installed: null,
        running: null,
        opened: false,
        message: "The Tailscale app check is available on macOS only.",
      };
    }

    const installed = Boolean(existsSync(tailscaleAppPath));
    if (!installed) {
      return {
        supported: true,
        installed: false,
        running: false,
        opened: false,
        message: "Tailscale is not installed. Install the Tailscale app to make the licensing server publicly reachable.",
      };
    }

    try {
      const running = Boolean(await checkTailscaleRunning());
      return {
        supported: true,
        installed: true,
        running,
        opened: false,
        message: running ? "Tailscale is running." : "Tailscale is installed but not running.",
      };
    } catch (error) {
      return {
        supported: true,
        installed: true,
        running: false,
        opened: false,
        error: error instanceof Error ? error.message : String(error || "The Tailscale app status could not be checked."),
        message: "The Tailscale app status could not be checked.",
      };
    }
  }

  async function ensureTailscaleRunning() {
    const state = await getTailscaleState();
    if (!state.supported || !state.installed || state.running) return state;
    try {
      await openTailscaleApp();
      return {
        ...state,
        error: "",
        opened: true,
        message: "Tailscale was closed, so the Tailscale app was opened. Wait for it to connect before checking the public endpoint.",
      };
    } catch (error) {
      return {
        ...state,
        error: `Tailscale is installed but could not be opened: ${error instanceof Error ? error.message : String(error || "unknown error")}`,
        message: "The licensing server can run locally, but Tailscale could not be opened.",
      };
    }
  }

  async function ensureTailscaleFunnel() {
    if (platform !== "darwin" || typeof tailscaleFunnelConfigure !== "function") return { configured: false, skipped: true };
    try {
      await tailscaleFunnelConfigure({ host, port });
      return { configured: true, error: "", message: "Tailscale Funnel is configured for the local licensing server." };
    } catch (error) {
      return {
        configured: false,
        error: error instanceof Error ? error.message : String(error || "The Tailscale Funnel route could not be configured."),
        message: "The licensing server is running locally, but Tailscale Funnel could not be configured.",
      };
    }
  }

  async function getState() {
    const publicEndpoint = publicUrl();
    const [healthy, directPublicHealthy, tailscale] = await Promise.all([
      healthCheck(`${url}/v1/health`),
      publicEndpoint ? publicHealthCheck(`${publicEndpoint}/v1/health`) : Promise.resolve(null),
      getTailscaleState(),
    ]);
    let observedPublicHealthy = directPublicHealthy;
    let publicHealthSource = directPublicHealthy === true ? "public" : "";
    if (publicEndpoint && directPublicHealthy === false && typeof publicProxyHealthCheck === "function") {
      const proxyHealthy = await publicProxyHealthCheck(`${String(publicProxyUrl).replace(/\/$/, "")}/v1/health`);
      if (proxyHealthy) {
        observedPublicHealthy = true;
        publicHealthSource = "website-proxy";
      }
    }
    if (publicEndpoint && observedPublicHealthy === true) {
      publicHealthyBeforeFailure = true;
      consecutivePublicFailures = 0;
    } else if (publicEndpoint && observedPublicHealthy === false) {
      consecutivePublicFailures += 1;
      // A public probe can fail briefly while Funnel reconnects or the
      // website proxy is redeployed. Keep an already healthy client state
      // stable for one failed probe and only report a real outage after two
      // consecutive failures.
      if (publicHealthyBeforeFailure === true && consecutivePublicFailures < 2) {
        observedPublicHealthy = true;
        publicHealthSource = "previous-check";
      } else {
        publicHealthyBeforeFailure = false;
      }
    }
    const publicHealthy = observedPublicHealthy;
    const storage = storageState();
    const autoStartStatus = manuallyStopped
      ? "stopped"
      : healthy
        ? "running"
        : autoStartRun || startRun
          ? storage.ssdMounted ? "starting" : "waiting-for-ssd"
          : !storage.ssdMounted
            ? "waiting-for-ssd"
            : "waiting-to-start";
    const state = {
      available: Boolean(existsSync(entryPath)),
      healthy,
      running: healthy,
      publicHealthy,
      managed: isAlive(child),
      url,
      publicUrl: publicEndpoint,
      publicHealthSource,
      autoStartEnabled: true,
      autoStartStatus,
      ...storage,
      tailscale,
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
    manuallyStopped = false;
    if (startRun) return startRun;
    startRun = startInternal().finally(() => { startRun = null; });
    return startRun;
  }

  async function startInternal() {
    const current = await getState();
    if (!current.ssdMounted) throw new Error("Connect the Sandisk Exf licensing SSD before starting the server.");
    if (!current.available) throw new Error("This agent release does not include the licensing server runtime.");
    const tailscale = await ensureTailscaleRunning();
    const currentWithTailscale = tailscale.opened || tailscale.error
      ? { ...current, tailscale }
      : current;
    // Do not reconfigure Funnel until the local service is ready. Starting
    // with a stale route is safe; pointing it at a not-yet-listening service
    // can make the public endpoint flap during owner startup.
    const funnel = current.healthy || (child && isAlive(child))
      ? (tailscale.error || tailscale.installed === false ? { configured: false, skipped: true } : await ensureTailscaleFunnel())
      : { configured: false, skipped: true };
    const tailscaleWithFunnel = funnel.skipped ? tailscale : { ...tailscale, funnel };
    const currentWithTailscaleAndFunnel = funnel.skipped
      ? currentWithTailscale
      : { ...currentWithTailscale, tailscale: tailscaleWithFunnel };
    const startMessage = tailscale.opened
      ? "The licensing server is running. Tailscale was closed, so the Tailscale app was opened. Wait for it to connect before checking the public endpoint."
      : funnel.error
        ? `The licensing server is running locally, but ${funnel.error}`
      : tailscale.error
        ? `The licensing server is running locally, but ${tailscale.error}`
        : tailscale.installed === false
          ? "The licensing server is running locally, but Tailscale is not installed."
          : "The licensing server is running.";
    if (current.healthy) return { ...currentWithTailscaleAndFunnel, started: false, message: startMessage };
    if (child && isAlive(child)) {
      await waitForHealth(child);
      const waitedFunnel = funnel.skipped && !funnel.configured && !funnel.error
        ? await ensureTailscaleFunnel()
        : funnel;
      const state = await getState();
      const waitedTailscale = waitedFunnel.skipped ? tailscale : { ...tailscale, funnel: waitedFunnel };
      return { ...state, ...(waitedFunnel.skipped ? (tailscale.opened || tailscale.error ? { tailscale } : {}) : { tailscale: waitedTailscale }), started: false, message: waitedFunnel.error ? `The licensing server is running locally, but ${waitedFunnel.error}` : startMessage };
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
    if (useElectronRuntime) {
      environment.ELECTRON_RUN_AS_NODE = "1";
      // The licensing server is external to app.asar. Its native SQLite
      // package is copied to Resources/node_modules for Node's ESM resolver;
      // retain the unpacked app dependency path too for CommonJS modules and
      // older package layouts.
      const packagedNodeModules = path.join(resourcesPath, "node_modules");
      const unpackedNodeModules = path.join(resourcesPath, "app.asar.unpacked", "node_modules");
      environment.NODE_PATH = [
        packagedNodeModules,
        unpackedNodeModules,
        process.env.NODE_PATH,
      ].filter(Boolean).join(path.delimiter);
    }

    const nextChild = spawnImpl(command, args, {
      cwd: spawnWorkingDirectory(),
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
      const startedFunnel = await ensureTailscaleFunnel();
      const finalTailscale = startedFunnel.skipped ? tailscale : { ...tailscale, funnel: startedFunnel };
      rememberOwnerMachine();
      const state = await getState();
      return { ...state, tailscale: startedFunnel.skipped && !tailscale.opened && !tailscale.error ? state.tailscale : finalTailscale, started: true, message: startedFunnel.error ? `The licensing server is running locally, but ${startedFunnel.error}` : startMessage };
    } catch (error) {
      if (isAlive(nextChild)) nextChild.kill?.("SIGTERM");
      throw error;
    }
  }

  async function stopProcess() {
    if (!child || !isAlive(child)) return getState();
    const stopping = child;
    stopping.kill?.("SIGTERM");
    const startedAt = Date.now();
    while (isAlive(stopping) && Date.now() - startedAt < 3000) await wait(50);
    if (isAlive(stopping)) stopping.kill?.("SIGKILL");
    return getState();
  }

  async function stop() {
    manuallyStopped = true;
    return stopProcess();
  }

  async function attemptAutoStart() {
    if (manuallyStopped) return getState();
    const storage = storageState();
    if (!storage.ssdMounted || !existsSync(entryPath)) {
      // Do not leave a running licensing process holding an SSD database open
      // after the volume is removed. Keep auto-start enabled so reinserting
      // the SSD starts the service again automatically.
      if (!storage.ssdMounted && child && isAlive(child)) await stopProcess();
      return getState();
    }
    try {
      const current = await getState();
      if (current.healthy || manuallyStopped) return current;
      return await start();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error || "The licensing server could not be started.");
      logger.warn?.(`Automatic licensing-server start is waiting: ${lastError}`);
      return getState();
    }
  }

  function watchForStorage() {
    if (autoStartTimer) return autoStartRun || Promise.resolve(getState());
    const run = () => {
      if (autoStartRun) return autoStartRun;
      autoStartRun = attemptAutoStart().finally(() => { autoStartRun = null; });
      return autoStartRun;
    };
    const firstRun = run();
    autoStartTimer = setInterval(run, autoStartIntervalMs);
    autoStartTimer.unref?.();
    return firstRun;
  }

  function stopWatching() {
    if (autoStartTimer) clearInterval(autoStartTimer);
    autoStartTimer = null;
  }

  return {
    getState,
    start,
    stop,
    watchForStorage,
    stopWatching,
    entryPath,
    findNode22Executable: () => findNode22Executable(app?.getPath?.("home") || process.env.HOME || ""),
  };
}

module.exports = { createLicenseServerManager, findNode22Executable, probeHealth };
