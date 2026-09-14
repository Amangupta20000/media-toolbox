import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getJob, getJobForPublic, claimNextJob, deleteJob, listExpiredJobs, listRetainedJobs, updateJob, appendJobLog } from "../lib/db.js";
import { config, paths } from "../lib/config.js";
import { acceptMultipartJob, likelyFileForTool, parseMultipart } from "../lib/job-intake.js";
import { recognizePdfText } from "../lib/pdf-ocr.js";
import { firstAvailable, runCommand } from "../lib/command.js";
import { processJob, writeCapabilities } from "../worker/index.js";
import { acceptLegalConsent as acceptLegalConsentAgent, activate as activateAgent, activateOnline, activateTester, authorizeProcessing, ensureAgentAuth, getActivationRequestStatus as getActivationRequestStatusAgent, getAuthorizationState as getAuthorizationStateAgent, getDeviceId as getDeviceIdFromAuth, getLicenseAdminAudit as getLicenseAdminAuditAgent, getLicenseAdminRequests as getLicenseAdminRequestsAgent, getLicenseAdminState as getLicenseAdminStateAgent, getLicenseRequestConfig as getLicenseRequestConfigAgent, hasOnlineLicenseServer, loginActivation as loginActivationAgent, loginAdmin as loginAdminAgent, loginLicenseAdmin as loginLicenseAdminAgent, logoutActivation as logoutActivationAgent, logoutAdmin as logoutAdminAgent, logoutLicenseAdmin as logoutLicenseAdminAgent, requestActivationCode as requestActivationCodeAgent, approveLicenseRequest as approveLicenseRequestAgent, declineLicenseRequest as declineLicenseRequestAgent, startTrial as startTrialAgent, TESTER_ACTIVATION_CODE } from "./auth.js";

const AGENT_VERSION = process.env.AGENT_VERSION || "0.2.1";
const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 4789;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const HISTORY_TOOLS = new Set(["image-converter", "video-repair", "pdf-editor", "pdf-text-editor", "pdf-compressor"]);
const state = {
  server: null,
  port: DEFAULT_PORT,
  protocol: "http",
  pairingCode: String(randomInt(100000, 1000000)),
  sessions: new Map(),
  allowedOrigins: new Set(),
  queueRunning: false,
  cleanupTimer: null,
  authorizationMode: "locked",
};

function processingSessionCount() {
  return [...state.sessions.values()].filter((session) => session.scope !== "history").length;
}

function currentAuthorization(now = Date.now()) {
  return getAuthorizationStateAgent(now, processingSessionCount());
}

function json(response, status, payload, request, origin = null) {
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function publicAuthorization(authorization) {
  const { deviceId: _deviceId, username: _username, ...value } = authorization || {};
  return value;
}

function originFor(request, allowAny = false) {
  const origin = request.headers.origin;
  if (!origin) return null;
  if (allowAny) return origin;
  return state.allowedOrigins.has(origin) ? origin : null;
}

function authorizationRequired(response, request, origin, authorization = currentAuthorization()) {
  return json(response, 402, {
    error: "Admin login or activation required.",
    code: "activation_required",
    authorization: publicAuthorization(authorization),
  }, request, origin);
}

function legalConsentRequired(response, request, origin, authorization = currentAuthorization()) {
  return json(response, 402, {
    error: "Accept the Privacy Policy and Terms & Conditions in the local agent dashboard before continuing.",
    code: "legal_consent_required",
    authorization: publicAuthorization(authorization),
  }, request, origin);
}

function addCors(request, response, allowAny = false) {
  const origin = originFor(request, allowAny);
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    // Chromium sends this preflight when a public HTTPS website accesses a
    // loopback agent. It is harmless for browsers that do not use Private
    // Network Access and prevents the successful local endpoint from being
    // hidden behind a browser-level CORS failure. Include it on the actual
    // response too because Edge/Chromium versions differ in when they check
    // the permission header.
    if (String(request.headers["access-control-request-private-network"] || "").toLowerCase() === "true" || origin.startsWith("https:")) {
      response.setHeader("Access-Control-Allow-Private-Network", "true");
    }
  }
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader("Access-Control-Max-Age", "600");
  return origin;
}

function tokenFrom(request, url) {
  const header = String(request.headers.authorization || "");
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
  return String(url.searchParams.get("access_token") || "");
}

function authorize(request, url) {
  const token = tokenFrom(request, url);
  const session = state.sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token && state.sessions.delete(token)) rebuildAllowedOrigins();
    return null;
  }
  const origin = request.headers.origin;
  if (origin && origin !== session.origin) return null;
  return { token, session };
}

function rebuildAllowedOrigins() {
  state.allowedOrigins = new Set(currentAuthorization().trustedOrigins);
}

function refreshAuthorization() {
  const authorization = currentAuthorization();
  state.allowedOrigins = new Set(authorization.trustedOrigins);
  if (!authorization.authorized && authorization.reason !== "activation_session_limit" && state.sessions.size) {
    for (const [token, session] of state.sessions) {
      if (session.scope !== "history") state.sessions.delete(token);
    }
  }
  state.authorizationMode = authorization.mode;
  return authorization;
}

export function revokeAllSessions() {
  const revokedCount = state.sessions.size;
  state.sessions.clear();
  rebuildAllowedOrigins();
  return revokedCount;
}

export function endSession(sessionId) {
  const entry = [...state.sessions.entries()].find(([, session]) => session.id === String(sessionId || ""));
  if (!entry) throw new Error("Session not found or already ended.");
  state.sessions.delete(entry[0]);
  rebuildAllowedOrigins();
  return { ok: true, revokedSessionId: entry[1].id, sessionCount: state.sessions.size };
}

function pruneExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of state.sessions) {
    if (session.expiresAt < now) {
      state.sessions.delete(token);
      changed = true;
    }
  }
  if (changed) rebuildAllowedOrigins();
}

function validateWebsiteOrigin(value, requestOrigin = "") {
  const requestedOrigin = String(value || "").trim();
  if (!requestedOrigin || requestedOrigin === "null") throw new Error("The website origin is required for pairing.");
  let parsedOrigin;
  try { parsedOrigin = new URL(requestedOrigin); } catch { throw new Error("The website origin is invalid."); }
  if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) throw new Error("Only an HTTP or HTTPS website origin can be paired.");
  if (requestOrigin && requestOrigin !== requestedOrigin) throw new Error("The pairing origin does not match this browser.");
  return requestedOrigin;
}

function issueSession(origin, clientLabel = "", scope = "processing") {
  const now = Date.now();
  const token = randomUUID();
  const session = {
    id: randomUUID(),
    origin,
    scope: scope === "history" ? "history" : "processing",
    clientLabel: String(clientLabel || "Website session").replace(/\s+/g, " ").trim().slice(0, 80) || "Website session",
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  state.sessions.set(token, session);
  return { token, session };
}

function publicSession(session, currentToken = "") {
  return {
    id: session.id,
    origin: session.origin,
    scope: session.scope || "processing",
    clientLabel: session.clientLabel,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    current: false,
    ...(currentToken ? { current: state.sessions.get(currentToken) === session } : {}),
  };
}

function authorizeHistory(origin, now = Date.now()) {
  const authorization = getAuthorizationStateAgent(now, processingSessionCount());
  if (!authorization.legalAccepted) return { ok: false, code: "legal_consent_required", state: authorization };
  if (!authorization.trustedOrigins.includes(origin)) return { ok: false, code: "origin_not_trusted", state: authorization };
  return { ok: true, state: authorization };
}

function isHistoryRequest(request, url) {
  if (url.pathname === "/v1/history" && request.method === "GET") return true;
  if (/^\/v1\/history\/[^/]+$/.test(url.pathname) && request.method === "DELETE") return true;
  if (/^\/v1\/jobs\/[^/]+\/download$/.test(url.pathname) && (request.method === "GET" || request.method === "HEAD")) return true;
  if (/^\/v1\/jobs\/[^/]+\/preview$/.test(url.pathname) && request.method === "GET") return true;
  if (url.pathname === "/v1/results/open" && request.method === "POST") return true;
  return false;
}

function readBody(request, limit = 16384) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > limit) return reject(new Error("The request is too large."));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

async function readJson(request) {
  let raw;
  try { raw = await readBody(request); } catch (error) { throw error; }
  try { return JSON.parse(raw || "{}"); } catch { throw new Error("The request body is not valid JSON."); }
}

function contentType(filename) {
  const extension = path.extname(filename || "").slice(1).toLowerCase();
  return {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif",
    tiff: "image/tiff", tif: "image/tiff", gif: "image/gif", bmp: "image/bmp", pdf: "application/pdf",
    mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  }[extension] || "application/octet-stream";
}

function safeDownloadName(name) {
  return String(name || "download").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function requestedDownloadName(requested, original) {
  const fallback = safeDownloadName(original || "download");
  if (!requested) return fallback;
  const extensionMatch = fallback.match(/\.[a-z0-9]{1,8}$/i);
  const extension = extensionMatch ? extensionMatch[0] : "";
  const candidateStem = safeDownloadName(requested).replace(/\.[a-z0-9]{1,8}$/i, "") || "download";
  return `${candidateStem}${extension}`;
}

function isWithinDirectory(candidate, directory) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedDirectory = path.resolve(directory);
  return resolvedCandidate === resolvedDirectory || resolvedCandidate.startsWith(`${resolvedDirectory}${path.sep}`);
}

function expandHomePath(value) {
  const input = String(value || "").trim();
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
  return input;
}

async function deleteDownloadedResult(folderPath, filename) {
  const requestedFolder = expandHomePath(folderPath);
  if (!requestedFolder || !path.isAbsolute(requestedFolder)) throw new Error("Enter an absolute Downloads folder path, such as ~/Downloads.");

  const downloadRoot = path.resolve(config.downloadsDirectory);
  const folder = path.resolve(requestedFolder);
  if (!isWithinDirectory(folder, downloadRoot)) throw new Error("For safety, choose the Downloads folder or a folder inside it.");

  let realRoot;
  let realFolder;
  try {
    realRoot = await fsp.realpath(downloadRoot);
    realFolder = await fsp.realpath(folder);
  } catch {
    throw new Error("The Downloads folder could not be found on this device.");
  }
  if (!isWithinDirectory(realFolder, realRoot)) throw new Error("The selected folder is not inside the Downloads folder.");

  const requestedName = String(filename || "").trim();
  if (!requestedName || requestedName === "." || requestedName === ".." || requestedName.includes("\0") || requestedName.includes("/") || requestedName.includes("\\") || path.basename(requestedName) !== requestedName) {
    throw new Error("The downloaded filename is invalid.");
  }
  const target = path.resolve(realFolder, requestedName);
  if (!isWithinDirectory(target, realRoot)) throw new Error("The requested file is outside the Downloads folder.");

  let targetStat;
  try { targetStat = await fsp.lstat(target); } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`The downloaded file \"${requestedName}\" was not found in that folder.`);
    throw error;
  }
  if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error("The matching download is not a regular file.");
  await fsp.unlink(target);
  return requestedName;
}

function rawResult(job) {
  if (!job?.result_json) return null;
  try { return JSON.parse(job.result_json); } catch { return null; }
}

function isRetainedJob(job) {
  if (!job || job.status !== "completed") return false;
  try { return JSON.parse(job.options_json || "{}").retention === "keep"; } catch { return false; }
}

function localJob(job, token) {
  const value = getJobForPublic(job.id);
  if (!value?.result) return value;
  const base = `${state.protocol}://127.0.0.1:${state.port}`;
  value.result.downloadUrl = `${base}/v1/jobs/${encodeURIComponent(job.id)}/download?access_token=${encodeURIComponent(token)}`;
  value.result.previewUrl = `${base}/v1/jobs/${encodeURIComponent(job.id)}/download?preview=1&access_token=${encodeURIComponent(token)}`;
  return value;
}

async function cleanupJob(jobId) {
  const job = getJob(jobId);
  if (!job) return;
  const result = rawResult(job);
  const sourceDirectory = path.dirname(job.source_path);
  await fsp.rm(sourceDirectory, { recursive: true, force: true });
  if (result?.path && !result.path.startsWith(`${sourceDirectory}${path.sep}`)) await fsp.rm(result.path, { force: true });
  deleteJob(jobId);
}

async function moveKeptResult(job) {
  const result = rawResult(job);
  if (!result?.path || !fs.existsSync(result.path)) return;
  const options = JSON.parse(job.options_json || "{}");
  if (options.retention !== "keep") return;
  const resultsDirectory = path.join(config.dataDir, "Results");
  await fsp.mkdir(resultsDirectory, { recursive: true });
  const filename = `${job.id.slice(0, 8)}-${safeDownloadName(result.filename || "result")}`;
  const keptPath = path.join(resultsDirectory, filename);
  await fsp.rename(result.path, keptPath);
  result.path = keptPath;
  updateJob(job.id, { result });
  appendJobLog(job.id, "Final result kept in the local Results folder.", "complete");
  await fsp.rm(path.dirname(job.source_path), { recursive: true, force: true });
}

function resultsDirectory() {
  return path.join(config.dataDir, "Results");
}

async function openResultsDirectory() {
  const directory = resultsDirectory();
  await fsp.mkdir(directory, { recursive: true });
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
  const child = spawn(opener, [directory], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return directory;
}

async function directoryWritable(directory) {
  await fsp.mkdir(directory, { recursive: true });
  const probe = path.join(directory, `.media-toolbox-self-test-${randomUUID()}`);
  await fsp.writeFile(probe, "Media Toolbox self-test\n", { flag: "wx" });
  await fsp.rm(probe, { force: true });
  return true;
}

function diagnosticItem(id, label, status, detail) {
  return { id, label, status, detail };
}

export async function runDiagnostics() {
  const results = [];
  results.push(diagnosticItem("agent", "Agent connectivity", state.server ? "pass" : "fail", state.server ? `Listening on ${state.protocol}://127.0.0.1:${state.port}` : "The local agent server is not running."));

  const resultsDir = resultsDirectory();
  const writableDirectories = [config.dataDir, paths.jobs, resultsDir];
  try {
    for (const directory of writableDirectories) await directoryWritable(directory);
    results.push(diagnosticItem("permissions", "File permissions", "pass", "The agent can create and remove files in its data, jobs, and Results folders."));
  } catch (error) {
    results.push(diagnosticItem("permissions", "File permissions", "fail", error instanceof Error ? error.message : "The agent cannot write to its data folders."));
  }

  try {
    const stats = await fsp.statfs(config.dataDir);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const requiredBytes = config.videoMaxBytes;
    const status = freeBytes >= requiredBytes ? "pass" : "warn";
    const freeGb = (freeBytes / 1024 ** 3).toFixed(1);
    results.push(diagnosticItem("disk", "Disk space", status, `${freeGb} GB is available. ${status === "pass" ? "Enough for the configured video limit." : "Low space may prevent large video jobs from completing."}`));
  } catch (error) {
    results.push(diagnosticItem("disk", "Disk space", "warn", error instanceof Error ? error.message : "Free disk space could not be measured."));
  }

  try { await writeCapabilities(); } catch { /* the capability report below still explains missing tools */ }
  let capabilities = {};
  try { capabilities = JSON.parse(await fsp.readFile(paths.capabilities, "utf8")); } catch { /* handled as unavailable */ }
  const toolChecks = [
    ["ffmpeg", "FFmpeg", capabilities.video?.ffmpeg, "Required for video repair and video previews."],
    ["imagemagick", "ImageMagick", capabilities.image?.imagemagick, capabilities.image?.sharp ? "Unavailable, but the bundled image engine can still process common formats." : "Required for ImageMagick image conversion."],
    ["heic", "HEIC support", capabilities.image?.heic, "HEIC can use macOS sips, ImageMagick/libheif, or the bundled HEIF engine."],
    ["mkv", "MKV support", capabilities.video?.mkvmerge || capabilities.video?.mkvFallback, capabilities.video?.mkvmerge ? "MKVToolNix is available for container reconstruction." : "FFmpeg fallback is available; MKVToolNix is not installed."],
    ["untrunc", "Untrunc", capabilities.video?.untrunc, "Optional: required only for reference-based recovery of missing MP4 metadata."],
  ];
  for (const [id, label, available, detail] of toolChecks) results.push(diagnosticItem(id, label, available ? "pass" : "warn", available ? "Available." : detail));
  return { ok: results.every((item) => item.status !== "fail"), checkedAt: new Date().toISOString(), items: results, capabilities: { ...capabilities, agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION } };
}

async function cleanupExpired() {
  const cutoff = Date.now() - config.jobRetentionHours * 60 * 60 * 1000;
  for (const row of listExpiredJobs(cutoff)) {
    const job = getJob(row.id);
    if (!job) continue;
    let options = {};
    try { options = JSON.parse(job.options_json || "{}"); } catch { /* use delete-by-default */ }
    if (options.retention === "keep") continue;
    await cleanupJob(row.id);
  }
}

async function processQueue() {
  if (state.queueRunning) return;
  state.queueRunning = true;
  try {
    while (true) {
      const job = claimNextJob();
      if (!job) break;
      await processJob(job);
      const completed = getJob(job.id);
      if (completed?.status === "completed") await moveKeptResult(completed);
    }
  } finally {
    state.queueRunning = false;
  }
}

function resultPathFor(job) {
  const result = rawResult(job);
  if (!result?.path) return null;
  const resolved = path.resolve(result.path);
  const dataRoot = `${path.resolve(config.dataDir)}${path.sep}`;
  return resolved.startsWith(dataRoot) ? resolved : null;
}

function streamResult(request, response, job, preview = false, onComplete = null, requestedFilename = "") {
  const result = rawResult(job);
  const resultPath = resultPathFor(job);
  if (!result || !resultPath || !fs.existsSync(resultPath)) {
    json(response, 410, { error: "Result has expired" }, request, originFor(request));
    return;
  }
  const fileSize = fs.statSync(resultPath).size;
  let start = 0;
  let end = fileSize - 1;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response.setHeader("Content-Range", `bytes */${fileSize}`);
      response.statusCode = 416;
      response.end();
      return;
    }
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    else end = fileSize - 1;
    if (!match[1]) start = Math.max(fileSize - Number(match[2]), 0);
    end = Math.min(end, fileSize - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= fileSize) {
      response.setHeader("Content-Range", `bytes */${fileSize}`);
      response.statusCode = 416;
      response.end();
      return;
    }
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  }
  const type = contentType(result.filename || resultPath);
  const origin = originFor(request);
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Content-Type", type);
  const downloadName = requestedDownloadName(requestedFilename, result.filename || "download");
  response.setHeader("Content-Disposition", `${preview ? "inline" : "attachment"}; filename="${downloadName}"`);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Length", String(end - start + 1));
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = fs.createReadStream(resultPath, { start, end });
  stream.on("error", () => response.destroy());
  if (onComplete) response.once("finish", onComplete);
  stream.pipe(response);
}

async function renderPdfPage(request, response, job, page) {
  if (!Number.isInteger(page) || page < 1 || page > 2000) return json(response, 400, { error: "Choose a valid PDF page number." }, request, originFor(request));
  const result = rawResult(job);
  const resultPath = resultPathFor(job);
  if (!result || !resultPath || path.extname(result.filename || resultPath).toLowerCase() !== ".pdf") return json(response, 415, { error: "The result is not a PDF." }, request, originFor(request));
  const pdftoppm = await firstAvailable(["pdftoppm"]);
  if (!pdftoppm) return json(response, 503, { error: "PDF preview is unavailable because Poppler is not installed." }, request, originFor(request));
  const tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "media-toolbox-agent-preview-"));
  const prefix = path.join(tempDirectory, `page-${page}-${randomUUID()}`);
  try {
    const rendered = await runCommand(pdftoppm, ["-f", String(page), "-l", String(page), "-singlefile", "-png", "-r", "110", resultPath, prefix], { timeoutMs: 120000 });
    const outputPath = `${prefix}.png`;
    if (rendered.code !== 0 || !fs.existsSync(outputPath)) return json(response, 400, { error: "This PDF page could not be rendered." }, request, originFor(request));
    const origin = originFor(request);
    if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
    response.setHeader("Content-Type", "image/png");
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("Cache-Control", "no-store");
    const stream = fs.createReadStream(outputPath);
    const cleanup = () => fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    stream.on("error", cleanup);
    response.once("finish", cleanup);
    stream.pipe(response);
  } catch {
    await fsp.rm(tempDirectory, { recursive: true, force: true });
    return json(response, 400, { error: "This PDF page could not be rendered." }, request, originFor(request));
  }
}

async function handle(request, response) {
  pruneExpiredSessions();
  const authorization = refreshAuthorization();
  const url = new URL(request.url || "/", `${state.protocol}://${request.headers.host || "127.0.0.1"}`);
  const pathParts = url.pathname.split("/").filter(Boolean);
  // CORS negotiation is separate from authorization. Echo the requesting
  // website origin for every agent API so browsers can read a useful 401/402
  // or 403 response during session discovery; each endpoint still validates
  // the origin, pairing, token, and authorization before returning data.
  const origin = addCors(request, response, pathParts[0] === "v1");
  if (request.method === "OPTIONS") {
    response.statusCode = origin || !request.headers.origin ? 204 : 403;
    response.end();
    return;
  }
  if (url.pathname === "/v1/health" && request.method === "GET") {
    const requestOrigin = String(request.headers.origin || "").trim();
    const sessionCount = requestOrigin
      ? [...state.sessions.values()].filter((session) => session.origin === requestOrigin).length
      : state.sessions.size;
    const paired = sessionCount > 0;
    const trustedOrigin = !requestOrigin || state.allowedOrigins.has(requestOrigin);
    return json(response, 200, {
      ok: true,
      service: "media-toolbox-agent",
      agentVersion: AGENT_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      protocol: state.protocol,
      platform: process.platform,
      arch: process.arch,
      paired,
      sessionCount,
      trustedOrigin,
      processingAvailable: authorization.authorized && trustedOrigin,
      trialAvailable: Boolean(authorization.legalAccepted && authorization.trialAvailable && trustedOrigin),
      authorization: publicAuthorization(authorization),
    }, request, origin || request.headers.origin || null);
  }
  if (url.pathname === "/v1/pair" && request.method === "POST") {
    try {
      const body = await readJson(request);
      const requestedOrigin = validateWebsiteOrigin(body.origin || request.headers.origin, request.headers.origin);
      if (String(body.code || "").trim() !== state.pairingCode) throw new Error("The pairing code is incorrect or expired.");
      const access = authorizeProcessing(requestedOrigin, Date.now(), processingSessionCount() + 1);
      if (!access.ok) {
        if (access.code === "origin_not_trusted") return json(response, 403, { error: "This website origin is not trusted by the local agent.", code: access.code, authorization: publicAuthorization(access.state) }, request, origin || request.headers.origin || null);
        if (access.code === "legal_consent_required") return legalConsentRequired(response, request, origin || request.headers.origin || null, access.state);
        return authorizationRequired(response, request, origin || request.headers.origin || null, access.state);
      }
      const { token, session } = issueSession(requestedOrigin, body.clientLabel);
      state.pairingCode = String(randomInt(100000, 1000000));
      console.log(`Browser paired for ${requestedOrigin} (${session.clientLabel}). A new pairing code is ready.`);
      return json(response, 200, { token, sessionId: session.id, expiresAt: session.expiresAt, protocolVersion: PROTOCOL_VERSION, autoPaired: false, authorization: publicAuthorization(access.state) }, request, origin || request.headers.origin || null);
    } catch (error) {
      return json(response, 401, { error: error instanceof Error ? error.message : "Pairing failed." }, request, origin || request.headers.origin || null);
    }
  }

  // A website origin that has already been explicitly trusted may create a
  // separate short-lived session for another browser, profile, or private
  // window without asking the user to copy the pairing code again. New
  // origins still require the one-time code above.
  if (url.pathname === "/v1/session" && request.method === "POST") {
    try {
      const body = await readJson(request);
      const requestedOrigin = validateWebsiteOrigin(body.origin || request.headers.origin, request.headers.origin);
      const historyOnly = body.historyOnly === true;
      const access = historyOnly
        ? authorizeHistory(requestedOrigin)
        : authorizeProcessing(requestedOrigin, Date.now(), processingSessionCount() + 1);
      if (!access.ok) {
        if (access.code === "origin_not_trusted") return json(response, 403, { error: "This website origin is not trusted by the local agent.", code: access.code, authorization: publicAuthorization(access.state) }, request, origin);
        if (access.code === "legal_consent_required") return legalConsentRequired(response, request, origin, access.state);
        return authorizationRequired(response, request, origin, access.state);
      }
      const { token, session } = issueSession(requestedOrigin, body.clientLabel, historyOnly ? "history" : "processing");
      return json(response, 200, { token, sessionId: session.id, expiresAt: session.expiresAt, sessionScope: session.scope, protocolVersion: PROTOCOL_VERSION, autoPaired: true, authorization: publicAuthorization(access.state) }, request, origin);
    } catch (error) {
      return json(response, 400, { error: error instanceof Error ? error.message : "The browser session could not be created." }, request, origin);
    }
  }

  const auth = authorize(request, url);
  const historyOnlySession = auth?.session?.scope === "history";
  const historyRequest = isHistoryRequest(request, url);
  if (historyOnlySession && !historyRequest) return json(response, 403, { error: "This session can only access saved history.", code: "history_session_only" }, request, origin);
  if (!authorization.authorized && !(historyOnlySession && historyRequest)) {
    const hasToken = Boolean(tokenFrom(request, url));
    if (authorization.reason === "legal_consent_required") return legalConsentRequired(response, request, origin, authorization);
    return hasToken
      ? authorizationRequired(response, request, origin, authorization)
      : json(response, 401, { error: "Create a local agent session before accessing this resource.", code: "session_required", authorization: publicAuthorization(authorization) }, request, origin);
  }
  if (!auth) return json(response, 401, { error: "Create a local agent session before accessing this resource.", code: "session_required", authorization: publicAuthorization(authorization) }, request, origin);
  // Native clients may not send an Origin header. If one is present, authorize()
  // has already verified that it matches the origin used during pairing.
  if (origin && origin !== auth.session.origin) return json(response, 403, { error: "This website origin is not paired with the local agent." }, request, origin);

  if (url.pathname === "/v1/pdf/ocr" && request.method === "POST") {
    const ocrDirectory = path.join(paths.jobs, `ocr-${randomUUID()}`);
    await fsp.mkdir(ocrDirectory, { recursive: true });
    let streamed = false;
    try {
      const { fields, files } = await parseMultipart(request, ocrDirectory, { fileSize: config.pdfMaxBytes });
      const sources = files.filter((file) => file.field === "source");
      if (sources.length !== 1) return json(response, 400, { error: "Add exactly one PDF for OCR." }, request, origin);
      const source = sources[0];
      if (!likelyFileForTool(source, "pdf-text-editor")) return json(response, 400, { error: "The uploaded file is not a PDF." }, request, origin);
      let pageIndexes;
      if (fields.pageIndexes) {
        try { pageIndexes = JSON.parse(fields.pageIndexes); } catch { return json(response, 400, { error: "The OCR page selection is invalid." }, request, origin); }
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();
      streamed = true;
      const writeEvent = (payload) => { if (!response.writableEnded) response.write(`${JSON.stringify(payload)}\n`); };
      writeEvent({ type: "progress", progress: 1, status: "starting", message: "Starting OCR…" });
      const result = await recognizePdfText(await fsp.readFile(source.path), {
        password: fields.password || "",
        pageIndexes,
        onProgress: (progress) => writeEvent({ type: "progress", ...progress }),
      });
      writeEvent({ type: "result", result });
      response.end();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The PDF could not be scanned with OCR.";
      if (streamed) {
        response.write(`${JSON.stringify({ type: "error", error: message })}\n`);
        response.end();
        return;
      }
      return json(response, /PasswordException|password/i.test(message) ? 422 : 400, { error: message }, request, origin);
    } finally {
      await fsp.rm(ocrDirectory, { recursive: true, force: true });
    }
  }

  if (url.pathname === "/v1/capabilities" && request.method === "GET") {
    try {
      const value = JSON.parse(await fsp.readFile(paths.capabilities, "utf8"));
      return json(response, 200, { ...value, agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION }, request, origin);
    } catch {
      return json(response, 200, { status: "starting", agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION, pdf: {}, image: {}, video: {} }, request, origin);
    }
  }

  if (url.pathname === "/v1/results/open" && request.method === "POST") {
    try {
      const directory = await openResultsDirectory();
      return json(response, 200, { ok: true, path: directory }, request, origin);
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : "The Results folder could not be opened." }, request, origin);
    }
  }

  if (url.pathname === "/v1/history" && request.method === "GET") {
    const tool = String(url.searchParams.get("tool") || "").trim();
    if (!HISTORY_TOOLS.has(tool)) return json(response, 400, { error: "Choose a supported tool for history." }, request, origin);
    const items = listRetainedJobs(tool)
      .filter((row) => {
        const resultPath = resultPathFor(row);
        return Boolean(resultPath && fs.existsSync(resultPath));
      })
      .map((row) => ({ ...localJob(row, auth.token), storedLocally: true, location: "Local agent Results folder" }));
    return json(response, 200, { items }, request, origin);
  }

  if (url.pathname === "/v1/files/delete" && request.method === "POST") {
    try {
      const body = await readJson(request);
      const deleted = await deleteDownloadedResult(body.folderPath, body.filename);
      return json(response, 200, { ok: true, deleted }, request, origin);
    } catch (error) {
      const status = /not found/i.test(error?.message || "") ? 404 : 400;
      return json(response, status, { error: error instanceof Error ? error.message : "The downloaded file could not be deleted." }, request, origin);
    }
  }

  if (url.pathname === "/v1/sessions" && request.method === "GET") {
    const items = [...state.sessions.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((session) => publicSession(session, auth.token));
    return json(response, 200, { items, sessionCount: items.length }, request, origin);
  }

  if (url.pathname === "/v1/sessions/revoke-all" && request.method === "POST") {
    const revokedCount = revokeAllSessions();
    return json(response, 200, { ok: true, revokedCount }, request, origin);
  }

  const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
  if (sessionMatch && request.method === "DELETE") {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const entry = [...state.sessions.entries()].find(([, session]) => session.id === sessionId);
    if (!entry) return json(response, 404, { error: "Session not found or already ended." }, request, origin);
    const [token, session] = entry;
    const current = token === auth.token;
    state.sessions.delete(token);
    rebuildAllowedOrigins();
    return json(response, 200, { ok: true, revokedSessionId: session.id, current, sessionCount: state.sessions.size }, request, origin);
  }

  if (url.pathname === "/v1/jobs" && request.method === "POST") {
    const id = randomUUID();
    const jobDir = path.join(paths.jobs, id);
    await fsp.mkdir(jobDir, { recursive: true });
    try {
      const result = await acceptMultipartJob(request, { id, jobDir });
      processQueue().catch((error) => console.error("Local agent queue failed", error));
      const ids = result?.ids || [id];
      return json(response, 202, { ...(ids.length === 1 ? { jobId: ids[0] } : { jobIds: ids }), status: "queued" }, request, origin);
    } catch (error) {
      await fsp.rm(jobDir, { recursive: true, force: true });
      return json(response, 400, { error: error instanceof Error ? error.message : "Upload failed." }, request, origin);
    }
  }

  const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)(?:\/(download|preview))?$/);
  if (jobMatch) {
    const id = decodeURIComponent(jobMatch[1]);
    const action = jobMatch[2];
    const job = getJob(id);
    if (!job) return json(response, 404, { error: "Job not found" }, request, origin);
    if (historyOnlySession && action && !isRetainedJob(job)) return json(response, 404, { error: "History item not found." }, request, origin);
    if (!action && request.method === "GET") return json(response, 200, localJob(job, auth.token), request, origin);
    if (action === "download" && (request.method === "GET" || request.method === "HEAD")) {
      return streamResult(request, response, job, url.searchParams.get("preview") === "1", () => {
        const options = JSON.parse(job.options_json || "{}");
        if (options.retention !== "keep" && url.searchParams.get("preview") !== "1") cleanupJob(id).catch(() => undefined);
      }, url.searchParams.get("filename") || "");
    }
    if (action === "preview" && request.method === "GET") {
      if (path.extname(rawResult(job)?.filename || "").toLowerCase() === ".pdf") return renderPdfPage(request, response, job, Number(url.searchParams.get("page") || 1));
      return streamResult(request, response, job, true);
    }
    if (!action && request.method === "DELETE") {
      await cleanupJob(id);
      return json(response, 200, { ok: true }, request, origin);
    }
  }

  const historyMatch = url.pathname.match(/^\/v1\/history\/([^/]+)$/);
  if (historyMatch && request.method === "DELETE") {
    const id = decodeURIComponent(historyMatch[1]);
    const job = getJob(id);
    if (!job) return json(response, 404, { error: "History item not found." }, request, origin);
    if (!isRetainedJob(job)) return json(response, 404, { error: "This result is not a retained history item." }, request, origin);
    await cleanupJob(id);
    return json(response, 200, { ok: true, deleted: id }, request, origin);
  }

  return json(response, 404, { error: "Agent route not found." }, request, origin);
}

export function getAgentState() {
  pruneExpiredSessions();
  const authorization = refreshAuthorization();
  return {
    pairingCode: state.pairingCode,
    port: state.port,
    running: Boolean(state.server),
    protocol: state.protocol,
    agentVersion: AGENT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    sessionCount: state.sessions.size,
    authorization,
  };
}

export function loginAdmin(username, password) {
  const authorization = loginAdminAgent(username, password);
  rebuildAllowedOrigins();
  return authorization;
}

export function acceptLegal() {
  const authorization = acceptLegalConsentAgent();
  rebuildAllowedOrigins();
  return authorization;
}

export function startTrial() {
  const authorization = startTrialAgent();
  rebuildAllowedOrigins();
  return authorization;
}

export function logoutAdmin() {
  const authorization = logoutAdminAgent();
  revokeAllSessions();
  return authorization;
}

export function logoutActivation() {
  const authorization = logoutActivationAgent();
  revokeAllSessions();
  return authorization;
}

export function loginActivation() {
  const authorization = loginActivationAgent();
  rebuildAllowedOrigins();
  revokeAllSessions();
  return authorization;
}

export function activateLicense(code) {
  const normalizedCode = String(code || "").trim();
  if (normalizedCode === TESTER_ACTIVATION_CODE) {
    const authorization = activateTester(normalizedCode);
    rebuildAllowedOrigins();
    revokeAllSessions();
    return authorization;
  }
  if (hasOnlineLicenseServer()) {
    return activateOnline(code).then((authorization) => {
      rebuildAllowedOrigins();
      revokeAllSessions();
      return authorization;
    });
  }
  const authorization = activateAgent(code);
  rebuildAllowedOrigins();
  revokeAllSessions();
  return authorization;
}

export function getLicenseRequestConfig() {
  return getLicenseRequestConfigAgent();
}

export function requestActivationCode(origin, requesterLabel, durationMs) {
  return requestActivationCodeAgent(origin, requesterLabel, durationMs);
}

export function getActivationRequestStatus(requestId, requestToken) {
  return getActivationRequestStatusAgent(requestId, requestToken);
}

export function getLicenseAdminState() {
  return getLicenseAdminStateAgent();
}

export function hasOnlineLicenseServerConfigured() {
  return hasOnlineLicenseServer();
}

export function loginLicenseAdmin(username, password) {
  return loginLicenseAdminAgent(username, password);
}

export function logoutLicenseAdmin() {
  return logoutLicenseAdminAgent();
}

export function getLicenseAdminRequests() {
  return getLicenseAdminRequestsAgent();
}

export function getLicenseAdminAudit(limit) {
  return getLicenseAdminAuditAgent(limit);
}

export function approveLicenseRequest(requestId) {
  return approveLicenseRequestAgent(requestId);
}

export function declineLicenseRequest(requestId, reason) {
  return declineLicenseRequestAgent(requestId, reason);
}

export function getDeviceId() {
  return getDeviceIdFromAuth();
}

export function getManagementState() {
  const authorization = refreshAuthorization();
  const sessions = [...state.sessions.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((session) => publicSession(session));
  return fsp.readFile(paths.capabilities, "utf8")
    .then((value) => JSON.parse(value))
    .catch(() => ({ status: "starting", image: {}, video: {} }))
    .then((capabilities) => ({
      ...getAgentState(),
      authorization,
      licenseAdmin: hasOnlineLicenseServer() ? getLicenseAdminStateAgent() : { authenticated: false },
      capabilities: { ...capabilities, agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION },
      sessions,
    }));
}

export async function startAgentServer({ port = Number(process.env.AGENT_PORT) || DEFAULT_PORT, host = "127.0.0.1", protocol = process.env.AGENT_PROTOCOL || "http", certPath = process.env.AGENT_TLS_CERT || "", keyPath = process.env.AGENT_TLS_KEY || "" } = {}) {
  if (state.server) return state.server;
  state.port = port;
  const tlsEnabled = protocol === "https";
  if (tlsEnabled && (!certPath || !keyPath)) throw new Error("HTTPS agent mode requires a certificate and private key.");
  ensureAgentAuth();
  rebuildAllowedOrigins();
  await fsp.mkdir(paths.jobs, { recursive: true });
  await writeCapabilities();
  state.protocol = tlsEnabled ? "https" : "http";
  console.log(`Media Toolbox local agent ${AGENT_VERSION} listening on ${state.protocol}://${host}:${port}`);
  console.log(`Pairing code: ${state.pairingCode}`);
  const requestHandler = (request, response) => {
    handle(request, response).catch((error) => {
      console.error("Local agent request failed", error);
      if (!response.headersSent) json(response, 500, { error: "The local agent could not complete the request." }, request, originFor(request));
      else response.destroy();
    });
  };
  state.server = tlsEnabled
    ? https.createServer({ cert: await fsp.readFile(certPath), key: await fsp.readFile(keyPath) }, requestHandler)
    : http.createServer(requestHandler);
  await new Promise((resolve, reject) => {
    state.server.once("error", reject);
    state.server.listen(port, host, resolve);
  });
  state.port = state.server.address().port;
  state.cleanupTimer = setInterval(() => cleanupExpired().catch(() => undefined), 60 * 1000);
  state.cleanupTimer.unref?.();
  return state.server;
}

export async function stopAgentServer() {
  if (state.cleanupTimer) clearInterval(state.cleanupTimer);
  state.cleanupTimer = null;
  if (!state.server) return;
  await new Promise((resolve) => state.server.close(resolve));
  state.server = null;
  state.protocol = "http";
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile && fileURLToPath(import.meta.url) === invokedFile) {
  startAgentServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
