import os from "node:os";
import path from "node:path";

const DEFAULT_VOLUME_UUID = "62D322F6-B7D6-3CB4-BB99-0A0A428E3F58";
const DEFAULT_SSD_DIRECTORY = "/Volumes/Sandisk Exf/MediaToolboxLicensing";
export const DEFAULT_ADMIN_PASSWORD = "Aman";

function origin(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function listOrigins(value) {
  return [...new Set(String(value || "").split(",").map(origin).filter(Boolean))];
}

export const licenseConfig = {
  host: process.env.LICENSE_SERVER_HOST || "127.0.0.1",
  port: Number(process.env.LICENSE_SERVER_PORT) || 4900,
  dataDir: path.resolve(process.env.LICENSE_DATA_DIR || (process.platform === "darwin" ? DEFAULT_SSD_DIRECTORY : path.join(process.cwd(), "license-data"))),
  volumeUuid: String(process.env.LICENSE_VOLUME_UUID || DEFAULT_VOLUME_UUID).trim().toUpperCase(),
  publicOrigins: listOrigins(process.env.LICENSE_PUBLIC_ORIGINS || "https://native-media-agent.vercel.app,http://localhost:3000,http://127.0.0.1:3000"),
  adminUsername: process.env.LICENSE_ADMIN_USERNAME || "Admin",
  adminPassword: process.env.LICENSE_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
  adminSessionTtlMs: 8 * 60 * 60 * 1000,
  requestTtlMs: 24 * 60 * 60 * 1000,
  licenseRequestCleanupIntervalMs: 60 * 1000,
  activationDurationMs: 10 * 60 * 1000,
  maxBodyBytes: 32 * 1024,
  ssdDirectory: DEFAULT_SSD_DIRECTORY,
  keychainService: "com.mediatoolbox.license-server.master-key",
  keychainAccount: os.userInfo().username || "media-toolbox",
  ssdMountPath: "/Volumes/Sandisk Exf",
  githubRepository: String(process.env.LICENSE_GITHUB_REPOSITORY || "Amangupta20000/media-toolbox").trim(),
  githubApiUrl: String(process.env.LICENSE_GITHUB_API_URL || "https://api.github.com").replace(/\/$/, ""),
  githubToken: String(process.env.LICENSE_GITHUB_TOKEN || "").trim(),
};

export function isConfiguredSsdDirectory(dataDir = licenseConfig.dataDir) {
  const root = path.resolve(licenseConfig.ssdDirectory);
  const candidate = path.resolve(dataDir);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
