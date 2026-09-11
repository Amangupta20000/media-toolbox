const path = require("node:path");
const { app, BrowserWindow, dialog, Menu, shell, Tray } = require("electron");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let agent;
  let tray;
  let pairingWindow;

  function showPairingCode() {
    const code = agent?.getAgentState().pairingCode || "Start the agent first.";
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
      alwaysOnTop: true,
      webPreferences: { contextIsolation: true, sandbox: true },
    });
    pairingWindow.on("closed", () => { pairingWindow = null; });
    const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:28px;background:#102b3b;color:#e6f3f5;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center}h1{margin:0 0 10px;font-size:21px}p{margin:0;color:#a8c0c9;line-height:1.45}code{display:block;margin:22px 0;padding:13px 10px;background:#0a1d29;border:1px solid #2aaeb2;border-radius:10px;color:#72e2df;font:700 34px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.18em}small{color:#94aeb8}</style></head><body><h1>Pair this browser</h1><p>Enter this code on the Media Toolbox website.</p><code>${code}</code><small>The code changes after a successful pairing.</small></body></html>`;
    pairingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    pairingWindow.once("ready-to-show", () => pairingWindow.show());
  }

  async function start() {
    process.env.DATA_DIR = path.join(app.getPath("userData"), "data");
    process.env.AGENT_SETUP_URL = process.env.AGENT_SETUP_URL || "http://localhost:3000/local-agent";
    if (process.platform === "darwin") app.dock?.hide();
    app.setLoginItemSettings({ openAtLogin: true });
    app.setAsDefaultProtocolClient("mediatoolbox");
    agent = await import("./server.js");
    await agent.startAgentServer();
    tray = new Tray(require("electron").nativeImage.createEmpty());
    tray.setToolTip("Media Toolbox local agent");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show pairing code", click: showPairingCode },
      { label: "Open agent setup", click: () => shell.openExternal(process.env.AGENT_SETUP_URL) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]));
  }

  app.on("second-instance", () => tray?.displayBalloon?.({ title: "Media Toolbox", content: "The local agent is already running." }));
  app.on("open-url", (event) => { event.preventDefault(); showPairingCode(); });
  app.whenReady().then(start).catch((error) => { dialog.showErrorBox("Media Toolbox agent could not start", error.message); app.quit(); });
  app.on("before-quit", async (event) => {
    if (!agent?.stopAgentServer) return;
    event.preventDefault();
    await agent.stopAgentServer();
    app.exit(0);
  });
}
