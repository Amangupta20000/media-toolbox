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
const DEFAULT_SQLITE_EXECUTABLE = process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
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

function probeHealthStatus(url, { httpModule = http, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = httpModule.get(url, { timeout: timeoutMs }, (response) => {
        const chunks = [];
        response.on?.("data", (chunk) => chunks.push(chunk));
        response.once?.("end", () => {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* a non-JSON response is still an endpoint response */ }
          finish({
            reachable: true,
            healthy: response.statusCode === 200 && body.ok !== false,
            statusCode: response.statusCode || 0,
            database: body.database && typeof body.database === "object" ? body.database : null,
            error: typeof body.error === "string" ? body.error : "",
          });
        });
        response.once?.("error", () => finish({ reachable: true, healthy: false, statusCode: response.statusCode || 0, database: null, error: "The health response could not be read." }));
      });
      request.once?.("error", () => finish({ reachable: false, healthy: false, statusCode: 0, database: null, error: "The licensing endpoint could not be reached." }));
      request.once?.("timeout", () => {
        request.destroy?.();
        finish({ reachable: false, healthy: false, statusCode: 0, database: null, error: "The licensing endpoint request timed out." });
      });
    } catch {
      finish({ reachable: false, healthy: false, statusCode: 0, database: null, error: "The licensing endpoint could not be checked." });
    }
  });
}

function probeHealth(url, options = {}) {
  return probeHealthStatus(url, options).then((value) => Boolean(value?.healthy));
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

function probeEndpointStatus(url, { timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return Promise.resolve({ reachable: false, healthy: false, statusCode: 0, database: null, error: "The public licensing URL is invalid." });
    return probeHealthStatus(url, { httpModule: parsed.protocol === "https:" ? https : http, timeoutMs });
  } catch {
    return Promise.resolve({ reachable: false, healthy: false, statusCode: 0, database: null, error: "The public licensing URL is invalid." });
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runExecFile(execFileImpl, file, args, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const callback = (error, stdout, stderr) => {
        resolve({
          ok: !error,
          error: error || null,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      };
      if (Object.keys(options).length) execFileImpl(file, args, options, callback);
      else execFileImpl(file, args, callback);
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
  sqliteExecutable = DEFAULT_SQLITE_EXECUTABLE,
  platform = process.platform,
  tailscaleAppPath = DEFAULT_TAILSCALE_APP_PATH,
  tailscaleRunningCheck = null,
  tailscaleOpen = null,
  healthCheck = null,
  publicHealthCheck = null,
  healthStatusCheck = null,
  publicHealthStatusCheck = null,
  publicProxyHealthCheck = null,
  publicProxyHealthStatusCheck = null,
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
  const localHealthCheck = healthCheck || ((target) => probeHealth(target));
  const remoteHealthCheck = publicHealthCheck || ((target) => probeEndpoint(target));
  const localHealthStatus = healthStatusCheck || (!healthCheck ? ((target) => probeHealthStatus(target)) : null);
  const remoteHealthStatus = publicHealthStatusCheck || (!publicHealthCheck ? ((target) => probeEndpointStatus(target)) : null);
  const publicProxyStatus = publicProxyHealthStatusCheck || (publicProxyHealthCheck
    ? async (target) => ({ reachable: true, healthy: Boolean(await publicProxyHealthCheck(target)), statusCode: 0, database: null, error: "" })
    : null);
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

  function databasePath(targetDataDirectory = dataDirectory) {
    return path.join(targetDataDirectory, "licenses.sqlite3");
  }

  async function inspectDatabase(targetPath = databasePath()) {
    if (!existsSync(targetPath)) return { status: "not-created", healthy: null, error: "The licensing database has not been created yet.", recoverable: false };
    if (!sqliteExecutable) return { status: "unavailable", healthy: null, error: "The SQLite diagnostic tool is not available in this agent.", recoverable: false };
    const result = await runExecFile(execFileImpl, sqliteExecutable, [targetPath, "PRAGMA quick_check(1);"]);
    const output = String(result.stdout || "").trim();
    const diagnostic = String(result.stderr || result.error?.message || "").trim();
    if (result.ok && output.toLowerCase() === "ok") return { status: "healthy", healthy: true, error: "", recoverable: false };
    const message = diagnostic || output || "SQLite integrity check failed.";
    if (/malformed|corrupt|not a database|disk image/i.test(message) || (result.ok && output && output.toLowerCase() !== "ok")) {
      return { status: "malformed", healthy: false, error: message, recoverable: true };
    }
    return { status: "unavailable", healthy: null, error: message, recoverable: false };
  }

  function runCommandWithInput(executable, args, input) {
    return new Promise((resolve, reject) => {
      let processHandle;
      try {
        processHandle = spawnImpl(executable, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      processHandle.stdout?.on?.("data", (chunk) => { stdout += String(chunk); });
      processHandle.stderr?.on?.("data", (chunk) => { stderr += String(chunk); });
      processHandle.once?.("error", reject);
      processHandle.once?.("close", (code, signal) => resolve({ ok: code === 0, code, signal, stdout, stderr }));
      processHandle.stdin?.end?.(input);
    });
  }

  async function recoverLicenseDatabase() {
    const storage = storageState();
    if (!storage.ownerConfigured || !storage.ssdMounted) throw new Error("Connect the licensing SSD before recovering its database.");
    const sourcePath = databasePath();
    if (!existsSync(sourcePath)) throw new Error("The licensing database does not exist, so there is nothing to recover.");
    if (!sqliteExecutable) throw new Error("This agent does not include the SQLite recovery tool.");
    const current = await inspectDatabase(sourcePath);
    if (current.healthy === true) return { ...(await getState()), recovery: { status: "not-needed", message: "The licensing database passed its integrity check; no recovery was needed." } };
    if (current.status !== "malformed") throw new Error(current.error || "The licensing database could not be checked safely.");
    const previousManualStop = manuallyStopped;
    manuallyStopped = true;
    if (child && isAlive(child)) await stopProcess();
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const backupPath = `${sourcePath}.malformed-${stamp}.bak`;
    const recoveredPath = `${sourcePath}.recovered-${stamp}.tmp`;
    try {
      await fs.promises.copyFile(sourcePath, backupPath);
      const recoveredSql = await runExecFile(execFileImpl, sqliteExecutable, [sourcePath, ".recover"], { maxBuffer: 32 * 1024 * 1024 });
      if (!recoveredSql.ok || !recoveredSql.stdout) throw new Error(String(recoveredSql.stderr || recoveredSql.error?.message || "SQLite could not recover the database contents."));
      const rebuilt = await runCommandWithInput(sqliteExecutable, [recoveredPath], recoveredSql.stdout);
      if (!rebuilt.ok) throw new Error(String(rebuilt.stderr || "SQLite could not write the recovered database."));
      const repaired = await inspectDatabase(recoveredPath);
      if (repaired.healthy !== true) throw new Error(repaired.error || "The recovered database did not pass its integrity check.");
      await fs.promises.rename(recoveredPath, sourcePath);
      manuallyStopped = false;
      lastError = "";
      const state = await start();
      return {
        ...state,
        recovery: {
          status: "recovered",
          backupPath,
          message: `The licensing database was recovered and the original was preserved at ${backupPath}.`,
        },
      };
    } catch (error) {
      await fs.promises.rm(recoveredPath, { force: true }).catch(() => {});
      manuallyStopped = previousManualStop;
      throw new Error(`${error instanceof Error ? error.message : String(error || "The licensing database could not be recovered.")} The original database was preserved at ${backupPath}.`);
    }
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
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await tailscaleFunnelConfigure({ host, port });
        return { configured: true, error: "", message: "Tailscale Funnel is configured for the local licensing server." };
      } catch (error) {
        lastError = error;
        if (attempt < 2) await wait(750);
      }
    }
    return {
      configured: false,
      error: lastError instanceof Error ? lastError.message : String(lastError || "The Tailscale Funnel route could not be configured."),
      message: "The licensing server is running locally, but Tailscale Funnel could not be configured.",
    };
  }

  async function getState() {
    const publicEndpoint = publicUrl();
    const storage = storageState();
    const [healthy, directPublicHealthy, tailscale, localStatus, publicStatus, proxyStatus] = await Promise.all([
      localHealthCheck(`${url}/v1/health`),
      publicEndpoint ? remoteHealthCheck(`${publicEndpoint}/v1/health`) : Promise.resolve(null),
      getTailscaleState(),
      localHealthStatus ? localHealthStatus(`${url}/v1/health`) : Promise.resolve(null),
      publicEndpoint && remoteHealthStatus ? remoteHealthStatus(`${publicEndpoint}/v1/health`) : Promise.resolve(null),
      publicEndpoint && publicProxyUrl && publicProxyStatus ? publicProxyStatus(`${String(publicProxyUrl).replace(/\/$/, "")}/v1/health`) : Promise.resolve(null),
    ]);
    let observedPublicHealthy = directPublicHealthy;
    let publicHealthSource = directPublicHealthy === true ? "public" : "";
    if (publicEndpoint && directPublicHealthy === false && proxyStatus?.healthy) {
      observedPublicHealthy = true;
      publicHealthSource = "website-proxy";
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
    const database = localStatus?.database || (storage.ownerConfigured ? await inspectDatabase() : { status: "not-applicable", healthy: null, error: "Owner storage is not available on this installation.", recoverable: false });
    const publicDatabase = publicStatus?.database || proxyStatus?.database || (directPublicHealthy === true
      ? { status: "healthy", healthy: true, error: "", recoverable: false }
      : directPublicHealthy === false
        ? { status: "unavailable", healthy: null, error: publicStatus?.error || proxyStatus?.error || "The public endpoint did not report database readiness.", recoverable: false }
        : { status: "checking", healthy: null, error: "", recoverable: false });
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
      database,
      publicDatabase,
      managed: isAlive(child),
      url,
      publicUrl: publicEndpoint,
      publicProxyUrl: publicProxyUrl || "",
      publicProxyHealthy: proxyStatus?.healthy === undefined ? null : Boolean(proxyStatus.healthy),
      publicProxyError: proxyStatus?.error || "",
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
      if (manuallyStopped) throw new Error("The licensing server start was cancelled.");
      if (childProcess && childProcess.exitCode !== null) {
        throw new Error(lastError || "The licensing server exited before becoming healthy.");
      }
      // Use the normalized health probe so packaged and development managers
      // work even when the caller does not inject a test-specific checker.
      if (await localHealthCheck(`${url}/v1/health`)) return;
      await wait(250);
    }
    throw new Error(`The licensing server did not become healthy at ${url}.`);
  }

  async function start({ automatic = false } = {}) {
    // A user-initiated Start clears the manual stop latch. Automatic retries
    // must not clear it, otherwise a Stop click racing with an SSD watcher
    // can immediately launch the server again.
    if (!automatic) manuallyStopped = false;
    if (automatic && manuallyStopped) return getState();
    if (startRun) return startRun;
    startRun = startInternal().finally(() => { startRun = null; });
    return startRun;
  }

  async function startInternal() {
    const current = await getState();
    if (manuallyStopped) throw new Error("The licensing server start was cancelled.");
    if (!current.ssdMounted) throw new Error("Connect the Sandisk Exf licensing SSD before starting the server.");
    if (!current.available) throw new Error("This agent release does not include the licensing server runtime.");
    const tailscale = await ensureTailscaleRunning();
    if (manuallyStopped) throw new Error("The licensing server start was cancelled.");
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
    if (manuallyStopped) throw new Error("The licensing server start was cancelled.");
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
    await stopProcess();
    // A stop request can arrive while automatic startup is still checking
    // Tailscale or the SSD, before the child process exists. Wait for that
    // start promise to settle so it cannot spawn a new server after Stop was
    // clicked and the button can immediately reflect the stopped state.
    if (startRun) await startRun.catch(() => {});
    return getState();
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
      return await start({ automatic: true });
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
    recoverLicenseDatabase,
    entryPath,
    findNode22Executable: () => findNode22Executable(app?.getPath?.("home") || process.env.HOME || ""),
  };
}

module.exports = { createLicenseServerManager, findNode22Executable, probeHealth, probeHealthStatus, probeEndpointStatus };
