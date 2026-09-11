import os from "node:os";
import path from "node:path";

function defaultDataDirectory() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "MediaToolbox", "data");
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "MediaToolbox", "data");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "MediaToolbox", "data");
}

process.env.DATA_DIR = defaultDataDirectory();
import("./server.js").then(({ startAgentServer }) => startAgentServer()).catch((error) => {
  console.error("Media Toolbox local agent failed to start:", error);
  process.exitCode = 1;
});
