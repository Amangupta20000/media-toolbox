import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isConfiguredSsdDirectory, licenseConfig } from "./config.js";

function volumeUuidForMount(mountPath) {
  if (process.platform !== "darwin") return "";
  try {
    const output = execFileSync("/usr/sbin/diskutil", ["info", mountPath], { encoding: "utf8", timeout: 5000 });
    return output.match(/Volume UUID:\s*([A-F0-9-]+)/i)?.[1]?.toUpperCase() || "";
  } catch {
    return "";
  }
}

function rejectSymlink(target) {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`Refusing to use a symbolic-link licensing directory: ${target}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function assertLicenseStorage(dataDir = licenseConfig.dataDir) {
  const candidate = path.resolve(dataDir);
  if (!path.isAbsolute(candidate)) throw new Error("The licensing data directory must be an absolute path.");
  if (isConfiguredSsdDirectory(candidate)) {
    const actualUuid = volumeUuidForMount(licenseConfig.ssdMountPath);
    if (!actualUuid || actualUuid !== licenseConfig.volumeUuid) {
      throw new Error(`The configured licensing SSD is not mounted with the expected volume UUID (${licenseConfig.volumeUuid}). No licensing files were opened.`);
    }
  } else if (process.env.LICENSE_ALLOW_NON_SSD !== "true" && process.env.NODE_ENV === "production") {
    throw new Error("Production licensing storage must be inside the configured dedicated SSD directory.");
  }
  rejectSymlink(candidate);
  return candidate;
}

export async function ensureLicenseStorage(dataDir = licenseConfig.dataDir) {
  const candidate = assertLicenseStorage(dataDir);
  await fsp.mkdir(candidate, { recursive: true, mode: 0o700 });
  rejectSymlink(candidate);
  return candidate;
}
