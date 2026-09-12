const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mediaToolboxAgent", {
  getState: () => ipcRenderer.invoke("agent:get-state"),
  login: (username, password) => ipcRenderer.invoke("agent:login", username, password),
  acceptLegal: () => ipcRenderer.invoke("agent:accept-legal"),
  startTrial: () => ipcRenderer.invoke("agent:start-trial"),
  getLicenseRequestConfig: () => ipcRenderer.invoke("agent:get-license-request-config"),
  requestActivationCode: (origin, durationMs) => ipcRenderer.invoke("agent:request-activation-code", origin, durationMs),
  getActivationRequestStatus: (requestId, requestToken) => ipcRenderer.invoke("agent:get-activation-request-status", requestId, requestToken),
  copyText: (value) => ipcRenderer.invoke("agent:copy-text", String(value || "")),
  logout: () => ipcRenderer.invoke("agent:logout"),
  activate: (code) => ipcRenderer.invoke("agent:activate", code),
  endSession: (sessionId) => ipcRenderer.invoke("agent:end-session", sessionId),
  endAllSessions: () => ipcRenderer.invoke("agent:end-all-sessions"),
  getLicenseRequests: () => ipcRenderer.invoke("agent:get-license-requests"),
  approveLicenseRequest: (requestId) => ipcRenderer.invoke("agent:approve-license-request", requestId),
  declineLicenseRequest: (requestId, reason) => ipcRenderer.invoke("agent:decline-license-request", requestId, reason),
  copyDeviceId: (deviceId) => ipcRenderer.invoke("agent:copy-device-id", deviceId),
});
