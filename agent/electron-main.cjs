const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, Tray } = require("electron");
const { autoUpdater } = require("electron-updater");
const { createLicenseServerManager, findNode22Executable } = require("./license-server-manager.cjs");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let agent;
  let tray;
  let pairingWindow;
  let pairingWatch;
  let dashboardWindow;
  let licenseServerManager;
  const updateState = {
    status: "unavailable",
    currentVersion: app.getVersion(),
    checkedAt: null,
    version: null,
    releaseDate: null,
    releaseNotes: null,
    progress: 0,
    error: "Updates are available after installing a packaged agent release.",
  };

  function publishUpdateState(nextState = {}) {
    Object.assign(updateState, nextState, { currentVersion: app.getVersion() });
    if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.webContents.send("agent:update-state", { ...updateState });
    return { ...updateState };
  }

  function canUseAutoUpdater() {
    return app.isPackaged && !process.defaultApp;
  }

  function setupAutoUpdater() {
    if (!canUseAutoUpdater()) {
      publishUpdateState({ status: "unavailable", error: "Updates are checked by packaged agent releases." });
      return;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => publishUpdateState({ status: "checking", error: "", checkedAt: new Date().toISOString() }));
    autoUpdater.on("update-available", (info) => publishUpdateState({ status: "available", version: info.version, releaseDate: info.releaseDate || null, releaseNotes: info.releaseNotes || null, progress: 0, error: "", checkedAt: new Date().toISOString() }));
    autoUpdater.on("update-not-available", (info) => publishUpdateState({ status: "up-to-date", version: info.version || app.getVersion(), releaseDate: info.releaseDate || null, releaseNotes: info.releaseNotes || null, progress: 0, error: "", checkedAt: new Date().toISOString() }));
    autoUpdater.on("download-progress", (progress) => publishUpdateState({ status: "downloading", progress: Math.max(0, Math.min(100, Math.round(progress.percent || 0))), error: "" }));
    autoUpdater.on("update-downloaded", (info) => publishUpdateState({ status: "downloaded", version: info.version, releaseDate: info.releaseDate || null, releaseNotes: info.releaseNotes || null, progress: 100, error: "" }));
    autoUpdater.on("error", (error) => publishUpdateState({ status: "error", error: error instanceof Error ? error.message : String(error || "The update check failed."), checkedAt: new Date().toISOString() }));
  }

  async function checkForUpdates() {
    if (!canUseAutoUpdater()) return publishUpdateState({ status: "unavailable", error: "Updates are checked by packaged agent releases.", checkedAt: new Date().toISOString() });
    try {
      await autoUpdater.checkForUpdates();
      return { ...updateState };
    } catch (error) {
      return publishUpdateState({ status: "error", error: error instanceof Error ? error.message : "The update check failed.", checkedAt: new Date().toISOString() });
    }
  }

  async function downloadUpdate() {
    if (!canUseAutoUpdater()) throw new Error("Updates are available only in a packaged agent release.");
    if (updateState.status !== "available" && updateState.status !== "error") throw new Error("There is no update ready to download.");
    await autoUpdater.downloadUpdate();
    return { ...updateState };
  }

  function installUpdate() {
    if (!canUseAutoUpdater()) throw new Error("Updates are available only in a packaged agent release.");
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
    dashboardWindow = new BrowserWindow({
      width: 1040,
      height: 800,
      minWidth: 820,
      minHeight: 620,
      show: false,
      title: "Media Toolbox Agent",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, "preload.cjs"),
      },
    });
    dashboardWindow.on("closed", () => { dashboardWindow = null; });
    dashboardWindow.loadFile(path.join(__dirname, "dashboard.html"));
    dashboardWindow.once("ready-to-show", () => { dashboardWindow?.show(); dashboardWindow?.focus(); });
    return dashboardWindow;
  }

  function registerDashboardIpc() {
    ipcMain.handle("agent:get-state", () => agent?.getManagementState?.() || {});
    ipcMain.handle("agent:get-update-state", () => ({ ...updateState }));
    ipcMain.handle("agent:check-for-updates", () => checkForUpdates());
    ipcMain.handle("agent:download-update", () => downloadUpdate());
    ipcMain.handle("agent:install-update", () => installUpdate());
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
    ipcMain.handle("agent:login", async (_event, username, password) => {
      const value = agent.loginAdmin(String(username || ""), String(password || ""));
      let licenseAdmin = agent.getLicenseAdminState();
      let licenseRequests = [];
      let licenseAudit = [];
      let licenseAuditStoragePath = "";
      let licenseAdminError = "";
      if (agent.hasOnlineLicenseServerConfigured()) {
        try {
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
    ipcMain.handle("agent:get-license-requests", async () => agent.getLicenseAdminRequests());
    ipcMain.handle("agent:get-license-audit", async () => agent.getLicenseAdminAudit());
    ipcMain.handle("agent:approve-license-request", async (_event, requestId) => agent.approveLicenseRequest(String(requestId || "")));
    ipcMain.handle("agent:decline-license-request", async (_event, requestId, reason) => agent.declineLicenseRequest(String(requestId || ""), String(reason || "Declined by owner")));
    ipcMain.handle("agent:copy-device-id", (_event, deviceId) => {
      const expected = agent.getDeviceId();
      if (String(deviceId || "") !== expected) throw new Error("The device ID is invalid.");
      clipboard.writeText(expected);
      return { ok: true };
    });
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
    licenseServerManager = createLicenseServerManager({
      app,
      moduleDirectory: __dirname,
      nodeExecutable: process.defaultApp ? findNode22Executable(app.getPath("home")) : "",
      electronExecutable: process.execPath,
      useElectronRuntime: !process.defaultApp,
    });
    // The owner dashboard may run on the same Mac as the SSD licensing
    // service. Prefer loopback there and fall back to the packaged public URL
    // for agents installed on other computers.
    process.env.AGENT_LICENSE_SERVER_LOCAL_URL = process.env.AGENT_LICENSE_SERVER_LOCAL_URL || "http://127.0.0.1:4900";
    process.env.DATA_DIR = path.join(app.getPath("userData"), "data");
    process.env.AGENT_SETUP_URL = process.env.AGENT_SETUP_URL || "http://localhost:3000/local-agent";
    if (process.platform === "darwin") app.dock?.hide();
    app.setLoginItemSettings({ openAtLogin: true, args: ["--hidden"] });
    app.setAsDefaultProtocolClient("mediatoolbox");
    const { ensureAgentCertificate } = await import("./tls.js");
    const certificate = await ensureAgentCertificate(path.join(app.getPath("userData"), "tls"));
    trustLocalCertificate(certificate.certPath);
    process.env.AGENT_PROTOCOL = "https";
    process.env.AGENT_TLS_CERT = certificate.certPath;
    process.env.AGENT_TLS_KEY = certificate.keyPath;
    agent = await import("./server.js");
    await agent.startAgentServer();
    registerDashboardIpc();
    setupAutoUpdater();
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
    await agent?.stopAgentServer?.();
    await licenseServerManager?.stop?.();
    app.exit(0);
  });
}
