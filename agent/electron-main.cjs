const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { execFile, execFileSync, spawnSync } = require("node:child_process");
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, shell, Tray } = require("electron");
const { autoUpdater } = require("electron-updater");
const { createLicenseServerManager, findNode22Executable } = require("./license-server-manager.cjs");
const { compareVersions, createRuntimeUpdater, readInstalledRuntime } = require("./runtime-update.cjs");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let agent;
  let tray;
  let pairingWindow;
  let pairingWatch;
  let dashboardWindow;
  let licenseServerManager;
  let runtimeUpdater;
  let installedRuntimeDirectory = "";
  const latestReleaseUrl = "https://github.com/Amangupta20000/media-toolbox/releases/latest";
  const updateState = {
    kind: "electron",
    status: "unavailable",
    currentVersion: app.getVersion(),
    checkedAt: null,
    version: null,
    updateType: null,
    releaseDate: null,
    releaseNotes: null,
    progress: 0,
    error: "Updates are available after installing a packaged agent release.",
  };

  function hasDeveloperIdSignature() {
    if (process.platform !== "darwin") return true;
    try {
      const result = spawnSync("/usr/bin/codesign", ["-dvvv", process.execPath], { encoding: "utf8" });
      const output = `${result.stdout || ""}\n${result.stderr || ""}`;
      return result.status === 0 && /Authority=Developer ID Application:/.test(output) && !/Signature=adhoc/.test(output);
    } catch {
      return false;
    }
  }

  function updateUnavailableMessage() {
    if (process.platform === "darwin" && app.isPackaged && !hasDeveloperIdSignature()) {
      return "Automatic macOS updates are unavailable for this unsigned build. Download the latest Mac release manually from GitHub Releases.";
    }
    return "Updates are checked by packaged agent releases.";
  }

  function fullInstallerMessage(version = "") {
    return `This release${version ? ` (v${version})` : ""} requires a full agent installer update. Download and install the latest release from GitHub Releases.`;
  }

  function isUnsignedMacPackage() {
    return process.platform === "darwin" && app.isPackaged && !hasDeveloperIdSignature();
  }

  function publishUpdateState(nextState = {}) {
    Object.assign(updateState, nextState, { currentVersion: app.getVersion() });
    if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send("agent:update-state", { ...updateState });
    return { ...updateState };
  }

  function canUseAutoUpdater() {
    return app.isPackaged && !process.defaultApp && hasDeveloperIdSignature();
  }

  function setupAutoUpdater() {
    if (!canUseAutoUpdater()) {
      if (isUnsignedMacPackage()) return;
      publishUpdateState({ kind: "electron", status: "unavailable", error: updateUnavailableMessage() });
      return;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => publishUpdateState({ kind: "electron", status: "checking", error: "", checkedAt: new Date().toISOString() }));
    autoUpdater.on("update-available", (info) => publishUpdateState({ kind: "electron", status: "available", version: info.version, releaseDate: info.releaseDate || null, releaseNotes: info.releaseNotes || null, progress: 0, error: "", checkedAt: new Date().toISOString() }));
    autoUpdater.on("update-not-available", (info) => publishUpdateState({ kind: "electron", status: "up-to-date", version: info.version || app.getVersion(), releaseDate: info.releaseDate || null, releaseNotes: info.releaseNotes || null, progress: 0, error: "", checkedAt: new Date().toISOString() }));
    autoUpdater.on("download-progress", (progress) => publishUpdateState({ kind: "electron", status: "downloading", progress: Math.max(0, Math.min(100, Math.round(progress.percent || 0))), error: "" }));
    autoUpdater.on("update-downloaded", (info) => publishUpdateState({ kind: "electron", status: "downloaded", version: info.version, releaseDate: info.releaseDate || null, releaseNotes: info.releaseNotes || null, progress: 100, error: "" }));
    autoUpdater.on("error", (error) => publishUpdateState({ kind: "electron", status: "error", error: error instanceof Error ? error.message : String(error || "The update check failed."), checkedAt: new Date().toISOString() }));
  }

  async function checkForRuntimeUpdates() {
    if (!runtimeUpdater) return publishUpdateState({ kind: "runtime", status: "unavailable", error: "Verified runtime updates are not configured in this agent build.", checkedAt: new Date().toISOString() });
    const nextState = await runtimeUpdater.check();
    if (nextState.status === "full-required") {
      return publishUpdateState({
        kind: "electron",
        status: "full-required",
        updateType: "full",
        version: nextState.version || null,
        runtimeVersion: nextState.runtimeVersion || null,
        error: nextState.error || fullInstallerMessage(nextState.version),
        checkedAt: new Date().toISOString(),
      });
    }
    if (nextState.status === "unavailable" || (nextState.status === "error" && /HTTP 404/i.test(nextState.error || ""))) {
      return publishUpdateState({ kind: "electron", status: "manual", error: updateUnavailableMessage(), checkedAt: new Date().toISOString() });
    }
    return nextState;
  }

  async function checkForUpdates() {
    if (!canUseAutoUpdater()) return isUnsignedMacPackage() ? checkForRuntimeUpdates() : publishUpdateState({ kind: "electron", status: "unavailable", error: updateUnavailableMessage(), checkedAt: new Date().toISOString() });
    try {
      await autoUpdater.checkForUpdates();
      return { ...updateState };
    } catch (error) {
      return publishUpdateState({ status: "error", error: error instanceof Error ? error.message : "The update check failed.", checkedAt: new Date().toISOString() });
    }
  }

  async function downloadUpdate() {
    if (updateState.kind === "runtime") {
      if (!runtimeUpdater) throw new Error("Verified runtime updates are not configured in this agent build.");
      return runtimeUpdater.download();
    }
    if (!canUseAutoUpdater()) throw new Error(updateUnavailableMessage());
    if (updateState.status !== "available" && updateState.status !== "error") throw new Error("There is no update ready to download.");
    await autoUpdater.downloadUpdate();
    return { ...updateState };
  }

  function installUpdate() {
    if (updateState.kind === "runtime") {
      if (!runtimeUpdater) throw new Error("Verified runtime updates are not configured in this agent build.");
      if (updateState.status !== "downloaded") throw new Error("Download the verified runtime update before installing it.");
      const result = runtimeUpdater.install();
      Promise.resolve(result).then(() => setTimeout(() => { app.relaunch(); app.quit(); }, 100)).catch((error) => {
        publishUpdateState({ kind: "runtime", status: "error", error: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() });
      });
      return result;
    }
    if (!canUseAutoUpdater()) throw new Error(updateUnavailableMessage());
    if (updateState.status !== "downloaded") throw new Error("Download the update before installing it.");
    autoUpdater.quitAndInstall(false, true);
    return { ...updateState };
  }

  function openDashboard() {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.show();
      dashboardWindow.focus();
      return dashboardWindow;
    }
    const runtimeAgentDirectory = installedRuntimeDirectory ? path.join(installedRuntimeDirectory, "agent") : "";
    const dashboardDirectory = runtimeAgentDirectory && fs.existsSync(path.join(runtimeAgentDirectory, "dashboard.html"))
      ? runtimeAgentDirectory
      : __dirname;
    dashboardWindow = new BrowserWindow({
      width: 1040,
      height: 800,
      minWidth: 820,
      minHeight: 620,
      movable: true,
      resizable: true,
      fullscreenable: true,
      titleBarStyle: "default",
      autoHideMenuBar: false,
      skipTaskbar: false,
      show: false,
      title: "Media Toolbox Agent",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(dashboardDirectory, "preload.cjs"),
      },
    });
    dashboardWindow.on("closed", () => { dashboardWindow = null; });
    dashboardWindow.loadFile(path.join(dashboardDirectory, "dashboard.html"));
    dashboardWindow.once("ready-to-show", () => {
      dashboardWindow?.show();
      dashboardWindow?.focus();
      if (process.platform === "darwin") app.focus({ steal: true });
    });
    return dashboardWindow;
  }

  function setupApplicationMenu() {
    const appSubmenu = process.platform === "darwin"
      ? [
        { role: "about" },
        { type: "separator" },
        { role: "services", submenu: [] },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ]
      : [{ label: "Quit", role: "quit" }];
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: appSubmenu },
      {
        label: "File",
        submenu: [
          { label: "Show Dashboard", click: openDashboard },
          { label: "Show Pairing Code", click: showPairingCode },
          { type: "separator" },
          { role: "close" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
      {
        label: "Help",
        submenu: [
          { label: "Open Website Setup", click: () => shell.openExternal(process.env.AGENT_SETUP_URL) },
          { label: "Open GitHub Releases", click: () => shell.openExternal(latestReleaseUrl) },
        ],
      },
    ]));
  }

  function registerDashboardIpc() {
    async function ensureOwnerLicenseServer() {
      if (!licenseServerManager?.getState || !licenseServerManager?.start) return;
      try {
        const state = await licenseServerManager.getState();
        // Runtime updates restart the Electron process before the owner
        // licensing child has necessarily finished auto-starting. Ensure the
        // owner service is ready before any dashboard request uses its local
        // or Funnel endpoint. Client installations have ownerConfigured=false
        // and are left untouched.
        if (state.ownerConfigured && !state.healthy) await licenseServerManager.start();
      } catch (error) {
        // The online request below still provides the useful endpoint error
        // when the SSD is disconnected or the owner service cannot start.
        console.warn("Owner licensing server is not ready:", error?.message || error);
      }
    }

    ipcMain.handle("agent:get-state", async () => {
      const state = await agent?.getManagementState?.() || {};
      // Local Admin authorization is persistent. Include the separately
      // persisted licensing-server session as well so a runtime update/restart
      // can restore the owner dashboard without forcing a second login.
      if (state.authorization?.mode === "admin" && agent?.hasOnlineLicenseServerConfigured?.()) {
        state.licenseAdmin = agent.getLicenseAdminState?.() || { authenticated: false };
      }
      return state;
    });
    ipcMain.handle("agent:get-update-state", () => ({ ...updateState }));
    ipcMain.handle("agent:check-for-updates", () => checkForUpdates());
    ipcMain.handle("agent:download-update", () => downloadUpdate());
    ipcMain.handle("agent:install-update", () => installUpdate());
    ipcMain.handle("agent:open-release-page", async () => {
      await shell.openExternal(latestReleaseUrl);
      return { ok: true, url: latestReleaseUrl };
    });
    ipcMain.handle("agent:run-diagnostics", () => agent?.runDiagnostics?.() || Promise.reject(new Error("The agent diagnostics are not ready.")));
    ipcMain.handle("agent:open-results-folder", async () => {
      const directory = path.join(app.getPath("userData"), "data", "Results");
      await fs.promises.mkdir(directory, { recursive: true });
      const error = await shell.openPath(directory);
      if (error) throw new Error(error);
      return { ok: true, path: directory };
    });
    ipcMain.handle("agent:get-license-server-state", () => licenseServerManager?.getState?.() || { available: false, healthy: false, running: false, error: "The licensing server manager is not ready." });
    ipcMain.handle("agent:start-license-server", () => licenseServerManager?.start?.() || Promise.reject(new Error("The licensing server manager is not ready.")));
    ipcMain.handle("agent:stop-license-server", () => licenseServerManager?.stop?.() || Promise.reject(new Error("The licensing server manager is not ready.")));
    ipcMain.handle("agent:recover-license-database", () => licenseServerManager?.recoverLicenseDatabase?.() || Promise.reject(new Error("The licensing server manager is not ready.")));
    ipcMain.handle("agent:login", async (_event, username, password) => {
      const value = agent.loginAdmin(String(username || ""), String(password || ""));
      let licenseAdmin = agent.getLicenseAdminState();
      let licenseRequests = [];
      let licenseAudit = [];
      let licenseAuditStoragePath = "";
      let licenseAdminError = "";
      if (agent.hasOnlineLicenseServerConfigured()) {
        try {
          await ensureOwnerLicenseServer();
          licenseAdmin = await agent.loginLicenseAdmin(String(username || ""), String(password || ""));
          licenseRequests = (await agent.getLicenseAdminRequests()).items || [];
          const audit = await agent.getLicenseAdminAudit();
          licenseAudit = audit.items || [];
          licenseAuditStoragePath = audit.storagePath || "";
        } catch (error) {
          licenseAdminError = error instanceof Error ? error.message : "The licensing requests could not be loaded.";
        }
      }
      const state = await agent.getManagementState();
      return { ...state, authorization: value, licenseAdmin, licenseRequests, licenseAudit, licenseAuditStoragePath, licenseAdminError };
    });
    ipcMain.handle("agent:accept-legal", () => {
      const value = agent.acceptLegal();
      return agent.getManagementState().then((state) => ({ ...state, authorization: value }));
    });
    ipcMain.handle("agent:start-trial", () => {
      const value = agent.startTrial();
      return agent.getManagementState().then((state) => ({ ...state, authorization: value }));
    });
    ipcMain.handle("agent:login-activation", () => {
      const value = agent.loginActivation();
      return agent.getManagementState().then((state) => ({ ...state, authorization: value }));
    });
    ipcMain.handle("agent:get-license-request-config", () => agent.getLicenseRequestConfig());
    ipcMain.handle("agent:request-activation-code", (_event, origin, durationMs) => agent.requestActivationCode(String(origin || ""), `Local agent dashboard · ${process.platform}`, Number(durationMs)));
    ipcMain.handle("agent:get-activation-request-status", (_event, requestId, requestToken) => agent.getActivationRequestStatus(String(requestId || ""), String(requestToken || "")));
    ipcMain.handle("agent:copy-text", (_event, value) => {
      clipboard.writeText(String(value || ""));
      return { ok: true };
    });
    ipcMain.handle("agent:logout", async () => {
      await agent.logoutLicenseAdmin();
      agent.logoutAdmin();
      return agent.getManagementState();
    });
    ipcMain.handle("agent:logout-activation", () => {
      const value = agent.logoutActivation();
      return agent.getManagementState().then((state) => ({ ...state, authorization: value }));
    });
    ipcMain.handle("agent:activate", async (_event, code) => {
      const value = await agent.activateLicense(String(code || ""));
      return agent.getManagementState().then((state) => ({ ...state, authorization: value }));
    });
    ipcMain.handle("agent:end-session", (_event, sessionId) => {
      const value = agent.endSession(String(sessionId || ""));
      return agent.getManagementState().then((state) => ({ ...state, sessionAction: value }));
    });
    ipcMain.handle("agent:end-all-sessions", () => {
      const value = agent.revokeAllSessions();
      return agent.getManagementState().then((state) => ({ ...state, revokedCount: value }));
    });
    ipcMain.handle("agent:get-license-requests", async () => { await ensureOwnerLicenseServer(); return agent.getLicenseAdminRequests(); });
    ipcMain.handle("agent:get-license-audit", async () => { await ensureOwnerLicenseServer(); return agent.getLicenseAdminAudit(); });
    ipcMain.handle("agent:approve-license-request", async (_event, requestId) => { await ensureOwnerLicenseServer(); return agent.approveLicenseRequest(String(requestId || "")); });
    ipcMain.handle("agent:decline-license-request", async (_event, requestId, reason) => { await ensureOwnerLicenseServer(); return agent.declineLicenseRequest(String(requestId || ""), String(reason || "Declined by owner")); });
  }

  function trustLocalCertificate(certPath) {
    try {
      if (process.platform === "darwin") {
        const keychain = path.join(app.getPath("home"), "Library", "Keychains", "login.keychain-db");
        execFileSync("/usr/bin/security", ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", keychain, certPath], { stdio: "ignore", timeout: 5000 });
      } else if (process.platform === "win32") {
        execFileSync("certutil", ["-user", "-addstore", "-f", "Root", certPath], { stdio: "ignore", timeout: 5000 });
      }
    } catch (error) {
      console.warn("The local HTTPS certificate could not be added to the user trust store:", error.message);
    }
  }

  async function checkPublicLicenseServer(url) {
    return (await checkPublicLicenseServerStatus(url)).healthy;
  }

  async function checkPublicLicenseServerStatus(url) {
    if (typeof net?.fetch !== "function") return { reachable: false, healthy: false, statusCode: 0, database: null, error: "The public licensing endpoint could not be checked." };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await net.fetch(url, { cache: "no-store", signal: controller.signal });
      const buffer = await response.arrayBuffer?.();
      let body = {};
      try { body = JSON.parse(new TextDecoder().decode(buffer || new ArrayBuffer(0))); } catch { /* a non-JSON response is still a response */ }
      return {
        reachable: true,
        healthy: response.status === 200 && body.ok !== false,
        statusCode: response.status,
        database: body.database && typeof body.database === "object" ? body.database : null,
        error: typeof body.error === "string" ? body.error : "",
      };
    } catch {
      return { reachable: false, healthy: false, statusCode: 0, database: null, error: "The public licensing endpoint could not be reached." };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function checkPublicLicenseProxy(url) {
    return checkPublicLicenseServer(url);
  }

  function configureTailscaleFunnel({ host = "127.0.0.1", port = 4900 } = {}) {
    if (process.platform !== "darwin") return Promise.resolve();
    const executable = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    return new Promise((resolve, reject) => {
      execFile(executable, ["funnel", "--bg", "--https=443", `http://${host}:${port}`], { timeout: 10_000 }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || "Tailscale Funnel could not be configured.").trim()));
          return;
        }
        resolve();
      });
    });
  }

  function showPairingCode() {
    const pairingState = agent?.getAgentState() || {};
    const initialPairingCode = pairingState.pairingCode;
    const initialSessionCount = pairingState.sessionCount || 0;
    const code = initialPairingCode || "Start the agent first.";
    if (pairingWindow && !pairingWindow.isDestroyed()) {
      pairingWindow.focus();
      return;
    }
    pairingWindow = new BrowserWindow({
      width: 430,
      height: 285,
      minWidth: 430,
      minHeight: 285,
      maxWidth: 430,
      maxHeight: 285,
      resizable: false,
      show: false,
      title: "Media Toolbox pairing code",
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    pairingWindow.on("closed", () => {
      if (pairingWatch) clearInterval(pairingWatch);
      pairingWatch = null;
      pairingWindow = null;
    });
    const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:28px;background:#102b3b;color:#e6f3f5;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}h1{margin:0 0 10px;font-size:21px}p{margin:0;color:#a8c0c9;line-height:1.45}code{display:block;margin:22px 0;padding:13px 10px;background:#0a1d29;border:1px solid #2aaeb2;border-radius:10px;color:#72e2df;font:700 34px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em}small{color:#94aeb8;display:block;line-height:1.4}</style></head><body><h1>Pair this browser</h1><p>Enter this code on the Media Toolbox website.</p><code>${code}</code><small>This temporary window closes after the browser connects.<br>The agent keeps running in the background.</small></body></html>`;
    pairingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    pairingWindow.once("ready-to-show", () => {
      pairingWindow.show();
      pairingWatch = setInterval(() => {
        if (!pairingWindow || pairingWindow.isDestroyed()) return;
        const nextState = agent?.getAgentState() || {};
        if (
          nextState.pairingCode !== initialPairingCode ||
          (nextState.sessionCount || 0) > initialSessionCount
        ) {
          pairingWindow.close();
        }
      }, 500);
      pairingWatch.unref?.();
    });
  }

  async function start() {
    loadLocalEnvironment();
    app.setName?.("Media Toolbox Agent");
    // Use Chromium's trusted network stack for all licensing requests in the
    // desktop process. This also keeps an older verified runtime compatible
    // if it does not yet expose the explicit auth fetch adapter below.
    if (typeof net?.fetch === "function") globalThis.fetch = net.fetch.bind(net);
    licenseServerManager = createLicenseServerManager({
      app,
      moduleDirectory: __dirname,
      nodeExecutable: process.defaultApp ? findNode22Executable(app.getPath("home")) : "",
      electronExecutable: process.execPath,
      useElectronRuntime: !process.defaultApp,
      publicHealthCheck: checkPublicLicenseServer,
      publicHealthStatusCheck: checkPublicLicenseServerStatus,
      publicProxyHealthCheck: checkPublicLicenseProxy,
      publicProxyHealthStatusCheck: checkPublicLicenseServerStatus,
      tailscaleFunnelConfigure: configureTailscaleFunnel,
    });
    // Prefer loopback only when this is the owner Mac. A released client agent
    // must not spend its first licensing request trying to contact a server on
    // its own computer; the licensing server normally lives on the owner's
    // machine and is reached through the packaged public HTTPS URL. Developers
    // can still opt in explicitly through AGENT_LICENSE_SERVER_LOCAL_URL.
    if (!process.env.AGENT_LICENSE_SERVER_LOCAL_URL && process.platform === "darwin" && fs.existsSync("/Volumes/Sandisk Exf")) {
      process.env.AGENT_LICENSE_SERVER_LOCAL_URL = "http://127.0.0.1:4900";
    }
    process.env.DATA_DIR = path.join(app.getPath("userData"), "data");
    process.env.AGENT_SETUP_URL = process.env.AGENT_SETUP_URL || "http://localhost:3000/local-agent";
    // This is a regular desktop application, not a background-only menu-bar
    // helper. Keep it in the Dock and let macOS install its application menu
    // when the dashboard window becomes the active app.
    if (process.platform === "darwin") app.dock?.show();
    app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
    app.setAsDefaultProtocolClient("mediatoolbox");
    const { ensureAgentCertificate } = await import("./tls.js");
    const certificate = await ensureAgentCertificate(path.join(app.getPath("userData"), "tls"));
    trustLocalCertificate(certificate.certPath);
    process.env.AGENT_PROTOCOL = "https";
    process.env.AGENT_TLS_CERT = certificate.certPath;
    process.env.AGENT_TLS_KEY = certificate.keyPath;
    runtimeUpdater = createRuntimeUpdater({
      userDataPath: app.getPath("userData"),
      moduleDirectory: __dirname,
      latestReleaseUrl,
      getCurrentVersion: () => app.getVersion(),
      onState: (value) => publishUpdateState(value),
    });
    const installedRuntime = await readInstalledRuntime({ userDataPath: app.getPath("userData"), moduleDirectory: __dirname });
    const bundledRuntimeIsCurrentOrNewer = !installedRuntime || compareVersions(app.getVersion(), installedRuntime.manifest.version) >= 0;
    installedRuntimeDirectory = bundledRuntimeIsCurrentOrNewer ? "" : installedRuntime.directory;
    if (installedRuntime && !bundledRuntimeIsCurrentOrNewer) {
      process.env.AGENT_VERSION = installedRuntime.manifest.version;
      agent = await import(`${pathToFileURL(path.join(installedRuntime.directory, "agent", "server.js")).href}?runtime=${encodeURIComponent(installedRuntime.manifest.version)}`);
      console.log(`Using verified local agent runtime ${installedRuntime.manifest.version}`);
    } else {
      if (installedRuntime) console.log(`Using bundled agent runtime ${app.getVersion()} instead of older saved runtime ${installedRuntime.manifest.version}`);
      agent = await import("./server.js");
    }
    if (typeof net?.fetch === "function" && typeof agent.setLicenseServerFetchImplementation === "function") {
      agent.setLicenseServerFetchImplementation((input, options) => net.fetch(input, options));
    }
    await agent.startAgentServer();
    registerDashboardIpc();
    // The owner licensing service follows the agent lifecycle. It starts in
    // the background when the SSD is already mounted and is retried whenever
    // the SSD appears later. A manual Stop action still suppresses retries
    // until the user explicitly starts the service again.
    licenseServerManager.watchForStorage?.().catch((error) => {
      console.warn("Automatic licensing-server startup is waiting:", error.message);
    });
    setupAutoUpdater();
    setupApplicationMenu();
    const firstUpdateCheck = setTimeout(() => checkForUpdates().catch(() => undefined), 8000);
    firstUpdateCheck.unref?.();
    const scheduledUpdateCheck = setInterval(() => checkForUpdates().catch(() => undefined), 6 * 60 * 60 * 1000);
    scheduledUpdateCheck.unref?.();
    tray = new Tray(require("electron").nativeImage.createEmpty());
    tray.setToolTip("Media Toolbox local agent");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show pairing code", click: showPairingCode },
      { label: "Open agent dashboard & sessions", click: openDashboard },
      { label: "Open website setup", click: () => shell.openExternal(process.env.AGENT_SETUP_URL) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]));
    if (!process.argv.includes("--hidden")) openDashboard();
  }

  function loadLocalEnvironment() {
    const filename = path.join(__dirname, "..", ".env.local");
    if (!fs.existsSync(filename)) return;
    for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }

  app.on("window-all-closed", (event) => event.preventDefault());
  app.on("second-instance", (_event, commandLine) => {
    if (commandLine.some((value) => String(value).includes("dashboard"))) openDashboard();
    else tray?.displayBalloon?.({ title: "Media Toolbox", content: "The local agent is already running." });
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (String(url || "").includes("dashboard")) openDashboard();
    else showPairingCode();
  });
  app.whenReady().then(start).catch((error) => { dialog.showErrorBox("Media Toolbox agent could not start", error.message); app.quit(); });
  app.on("before-quit", async (event) => {
    if (!agent?.stopAgentServer && !licenseServerManager?.stop) return;
    event.preventDefault();
    licenseServerManager?.stopWatching?.();
    await agent?.stopAgentServer?.();
    await licenseServerManager?.stop?.();
    app.exit(0);
  });
}
