import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDirectory = process.env.HOME || "";
const bundledUntruncName = process.platform === "win32" ? "untrunc.exe" : "untrunc";
const bundledUntruncDirectory = `${process.platform}-${process.arch}`;
const projectLocalUntrunc = path.join(projectDirectory, "vendor", "untrunc", bundledUntruncDirectory, bundledUntruncName);
const legacyProjectLocalUntrunc = path.join(projectDirectory, "vendor", "untrunc-macos", "untrunc");
const desktopProjectUntrunc = path.join(
  homeDirectory,
  "Desktop",
  "MediaToolbox",
  "vendor",
  "untrunc-macos",
  "untrunc",
);

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  appName: process.env.NEXT_PUBLIC_APP_NAME || "Media Toolbox",
  dataDir: path.resolve(
    process.env.DATA_DIR || path.join(process.cwd(), "data"),
  ),
  downloadsDirectory: path.resolve(
    process.env.MEDIA_TOOLBOX_DOWNLOADS_DIR || path.join(homeDirectory, "Downloads"),
  ),
  jobRetentionHours: numberFromEnv("JOB_RETENTION_HOURS", 2),
  imageMaxBytes: numberFromEnv("IMAGE_MAX_BYTES", 25 * 1024 * 1024),
  videoMaxBytes: numberFromEnv("VIDEO_MAX_BYTES", 2 * 1024 * 1024 * 1024),
  pdfMaxBytes: numberFromEnv("PDF_MAX_BYTES", 50 * 1024 * 1024),
  pdfTotalMaxBytes: numberFromEnv("PDF_TOTAL_MAX_BYTES", 250 * 1024 * 1024),
  pdfImageMaxBytes: numberFromEnv("PDF_IMAGE_MAX_BYTES", 25 * 1024 * 1024),
  username: process.env.APP_USERNAME || "admin",
  password: process.env.APP_PASSWORD || "12345",
  authSecret: process.env.AUTH_SECRET || "local-development-secret",
  untruncPath: process.env.UNTRUNC_PATH || "/usr/local/bin/untrunc",
  untruncReferencePath: process.env.UNTRUNC_REFERENCE_PATH
    ? path.resolve(process.env.UNTRUNC_REFERENCE_PATH)
    : "",
};

export const untruncCandidates = [
  projectLocalUntrunc,
  legacyProjectLocalUntrunc,
  config.untruncPath,
  "/opt/homebrew/bin/untrunc",
  path.join(homeDirectory, "Movies", "Record Go", ".untrunc_recordgo"),
  desktopProjectUntrunc,
  path.join(
    homeDirectory,
    "Documents",
    "Codex",
    "2026-09-11",
    "thi",
    "work",
    "untrunc",
    "untrunc",
  ),
].filter((value, index, values) => value && values.indexOf(value) === index);

export const paths = {
  jobs: path.join(config.dataDir, "jobs"),
  pdfPreviews: path.join(config.dataDir, "pdf-previews"),
  capabilities: path.join(config.dataDir, "capabilities.json"),
  database: path.join(config.dataDir, "jobs.sqlite3"),
};

export const supportedImageFormats = [
  { value: "original", label: "Original format", extension: "" },
  { value: "jpeg", label: "JPG / JPEG", extension: "jpg" },
  { value: "png", label: "PNG", extension: "png" },
  { value: "heic", label: "HEIC / HEIF", extension: "heic" },
  { value: "tiff", label: "TIFF", extension: "tiff" },
  { value: "gif", label: "GIF", extension: "gif" },
  { value: "bmp", label: "BMP", extension: "bmp" },
];
