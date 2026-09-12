const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, Tray } = require("electron");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let agent;
  let tray;
  let pairingWindow;
  let pairingWatch;
  let dashboardWindow;

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
    ipcMain.handle("agent:login", (_event, username, password) => {
      const value = agent.loginAdmin(String(username || ""), String(password || ""));
      return agent.getManagementState().then((state) => ({ ...state, authorization: value }));
    });
    ipcMain.handle("agent:accept-legal", () => {
      const value = agent.acceptLegal();
      return agent.getManagementState().then((state) => ({ ...state, authorization: value }));
    });
    ipcMain.handle("agent:start-trial", () => {
      const value = agent.startTrial();
      return agent.getManagementState().then((state) => ({ ...state, authorization: value }));
    });
    ipcMain.handle("agent:get-license-request-config", () => agent.getLicenseRequestConfig());
    ipcMain.handle("agent:request-activation-code", (_event, origin) => agent.requestActivationCode(String(origin || ""), `Local agent dashboard · ${process.platform}`));
    ipcMain.handle("agent:get-activation-request-status", (_event, requestId, requestToken) => agent.getActivationRequestStatus(String(requestId || ""), String(requestToken || "")));
    ipcMain.handle("agent:copy-text", (_event, value) => {
      clipboard.writeText(String(value || ""));
      return { ok: true };
    });
    ipcMain.handle("agent:logout", () => {
      agent.logoutAdmin();
      return agent.getManagementState();
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
    if (!agent?.stopAgentServer) return;
    event.preventDefault();
    await agent.stopAgentServer();
    app.exit(0);
  });
}
