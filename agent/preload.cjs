const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("mediaToolboxAgent", {
  getState: () => ipcRenderer.invoke("agent:get-state"),
  login: (username, password) => ipcRenderer.invoke("agent:login", username, password),
  acceptLegal: () => ipcRenderer.invoke("agent:accept-legal"),
  logout: () => ipcRenderer.invoke("agent:logout"),
  activate: (code) => ipcRenderer.invoke("agent:activate", code),
  endSession: (sessionId) => ipcRenderer.invoke("agent:end-session", sessionId),
  endAllSessions: () => ipcRenderer.invoke("agent:end-all-sessions"),
  copyDeviceId: (deviceId) => ipcRenderer.invoke("agent:copy-device-id", deviceId),
});
