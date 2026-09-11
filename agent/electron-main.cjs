const path = require("node:path");
const { app, dialog, Menu, shell, Tray } = require("electron");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let agent;
  let tray;

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
      { label: "Show pairing code", click: () => dialog.showMessageBox({ type: "info", title: "Media Toolbox pairing code", message: `Enter this one-time code on the website:\n\n${agent.getAgentState().pairingCode}`, detail: "The code changes after each successful pairing." }) },
      { label: "Open agent setup", click: () => shell.openExternal(process.env.AGENT_SETUP_URL) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]));
  }

  app.on("second-instance", () => tray?.displayBalloon?.({ title: "Media Toolbox", content: "The local agent is already running." }));
  app.on("open-url", (event) => { event.preventDefault(); dialog.showMessageBox({ type: "info", title: "Media Toolbox pairing code", message: `Pairing code: ${agent?.getAgentState().pairingCode || "Start the agent first."}` }); });
  app.whenReady().then(start).catch((error) => { dialog.showErrorBox("Media Toolbox agent could not start", error.message); app.quit(); });
  app.on("before-quit", async (event) => {
    if (!agent?.stopAgentServer) return;
    event.preventDefault();
    await agent.stopAgentServer();
    app.exit(0);
  });
}
