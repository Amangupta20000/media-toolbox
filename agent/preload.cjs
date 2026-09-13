const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mediaToolboxAgent", {
  getState: () => ipcRenderer.invoke("agent:get-state"),
  getUpdateState: () => ipcRenderer.invoke("agent:get-update-state"),
  checkForUpdates: () => ipcRenderer.invoke("agent:check-for-updates"),
  downloadUpdate: () => ipcRenderer.invoke("agent:download-update"),
  installUpdate: () => ipcRenderer.invoke("agent:install-update"),
  openReleasePage: () => ipcRenderer.invoke("agent:open-release-page"),
  onUpdateState: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("agent:update-state", (_event, value) => callback(value));
  },
  runDiagnostics: () => ipcRenderer.invoke("agent:run-diagnostics"),
  openResultsFolder: () => ipcRenderer.invoke("agent:open-results-folder"),
  getLicenseServerState: () => ipcRenderer.invoke("agent:get-license-server-state"),
  startLicenseServer: () => ipcRenderer.invoke("agent:start-license-server"),
  stopLicenseServer: () => ipcRenderer.invoke("agent:stop-license-server"),
  recoverLicenseDatabase: () => ipcRenderer.invoke("agent:recover-license-database"),
  login: (username, password) => ipcRenderer.invoke("agent:login", username, password),
  acceptLegal: () => ipcRenderer.invoke("agent:accept-legal"),
  startTrial: () => ipcRenderer.invoke("agent:start-trial"),
  loginActivation: () => ipcRenderer.invoke("agent:login-activation"),
  getLicenseRequestConfig: () => ipcRenderer.invoke("agent:get-license-request-config"),
  requestActivationCode: (origin, durationMs) => ipcRenderer.invoke("agent:request-activation-code", origin, durationMs),
  getActivationRequestStatus: (requestId, requestToken) => ipcRenderer.invoke("agent:get-activation-request-status", requestId, requestToken),
  copyText: (value) => ipcRenderer.invoke("agent:copy-text", String(value || "")),
  logout: () => ipcRenderer.invoke("agent:logout"),
  logoutActivation: () => ipcRenderer.invoke("agent:logout-activation"),
  activate: (code) => ipcRenderer.invoke("agent:activate", code),
  endSession: (sessionId) => ipcRenderer.invoke("agent:end-session", sessionId),
  endAllSessions: () => ipcRenderer.invoke("agent:end-all-sessions"),
  getLicenseRequests: () => ipcRenderer.invoke("agent:get-license-requests"),
  getLicenseAudit: () => ipcRenderer.invoke("agent:get-license-audit"),
  approveLicenseRequest: (requestId) => ipcRenderer.invoke("agent:approve-license-request", requestId),
  declineLicenseRequest: (requestId, reason) => ipcRenderer.invoke("agent:decline-license-request", requestId, reason),
});
