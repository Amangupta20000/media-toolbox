import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getJob, getJobForPublic, claimNextJob, deleteJob, listExpiredJobs, listRetainedJobs, updateJob, appendJobLog } from "../lib/db.js";
import { config, paths } from "../lib/config.js";
import { acceptMultipartJob } from "../lib/job-intake.js";
import { firstAvailable, runCommand } from "../lib/command.js";
import { processJob, writeCapabilities } from "../worker/index.js";

const AGENT_VERSION = process.env.AGENT_VERSION || "0.1.0";
const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 4789;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const HISTORY_TOOLS = new Set(["image-converter", "video-repair", "pdf-editor"]);
const state = {
  server: null,
  port: DEFAULT_PORT,
  pairingCode: String(randomInt(100000, 1000000)),
  sessions: new Map(),
  allowedOrigins: new Set(),
  queueRunning: false,
  cleanupTimer: null,
};

function json(response, status, payload, request, origin = null) {
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function originFor(request, allowAny = false) {
  const origin = request.headers.origin;
  if (!origin) return null;
  if (allowAny) return origin;
  return state.allowedOrigins.has(origin) ? origin : null;
}

function addCors(request, response, allowAny = false) {
  const origin = originFor(request, allowAny);
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
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
    if (token) state.sessions.delete(token);
    return null;
  }
  const origin = request.headers.origin;
  if (origin && origin !== session.origin) return null;
  return { token, session };
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

function localJob(job, token) {
  const value = getJobForPublic(job.id);
  if (!value?.result) return value;
  const base = `http://127.0.0.1:${state.port}`;
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

function streamResult(request, response, job, preview = false, onComplete = null) {
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
  response.setHeader("Content-Disposition", `${preview ? "inline" : "attachment"}; filename="${safeDownloadName(result.filename || "download")}"`);
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
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const origin = addCors(request, response, pathParts[0] === "v1" && ["health", "pair"].includes(pathParts[1]));
  if (request.method === "OPTIONS") {
    response.statusCode = origin || !request.headers.origin ? 204 : 403;
    response.end();
    return;
  }
  if (url.pathname === "/v1/health" && request.method === "GET") {
    const requestOrigin = String(request.headers.origin || "").trim();
    const paired = requestOrigin ? state.allowedOrigins.has(requestOrigin) : state.allowedOrigins.size > 0;
    return json(response, 200, { ok: true, service: "media-toolbox-agent", agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION, platform: process.platform, arch: process.arch, paired }, request, origin || request.headers.origin || null);
  }
  if (url.pathname === "/v1/pair" && request.method === "POST") {
    try {
      const body = await readJson(request);
      const requestedOrigin = String(body.origin || request.headers.origin || "").trim();
      if (!requestedOrigin || requestedOrigin === "null") throw new Error("The website origin is required for pairing.");
      let parsedOrigin;
      try { parsedOrigin = new URL(requestedOrigin); } catch { throw new Error("The website origin is invalid."); }
      if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) throw new Error("Only an HTTP or HTTPS website origin can be paired.");
      if (request.headers.origin && request.headers.origin !== requestedOrigin) throw new Error("The pairing origin does not match this browser.");
      if (String(body.code || "").trim() !== state.pairingCode) throw new Error("The pairing code is incorrect or expired.");
      const token = randomUUID();
      state.sessions.set(token, { origin: requestedOrigin, expiresAt: Date.now() + SESSION_TTL_MS });
      state.allowedOrigins.add(requestedOrigin);
      state.pairingCode = String(randomInt(100000, 1000000));
      console.log(`Browser paired for ${requestedOrigin}. A new pairing code is ready.`);
      return json(response, 200, { token, expiresAt: Date.now() + SESSION_TTL_MS, protocolVersion: PROTOCOL_VERSION }, request, origin || request.headers.origin || null);
    } catch (error) {
      return json(response, 401, { error: error instanceof Error ? error.message : "Pairing failed." }, request, origin || request.headers.origin || null);
    }
  }

  const auth = authorize(request, url);
  if (!auth) return json(response, 401, { error: "Pair the website with the local agent first." }, request, origin);
  // Native clients may not send an Origin header. If one is present, authorize()
  // has already verified that it matches the origin used during pairing.
  if (origin && origin !== auth.session.origin) return json(response, 403, { error: "This website origin is not paired with the local agent." }, request, origin);

  if (url.pathname === "/v1/capabilities" && request.method === "GET") {
    try {
      const value = JSON.parse(await fsp.readFile(paths.capabilities, "utf8"));
      return json(response, 200, { ...value, agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION }, request, origin);
    } catch {
      return json(response, 200, { status: "starting", agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION, image: {}, video: {} }, request, origin);
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

  if (url.pathname === "/v1/jobs" && request.method === "POST") {
    const id = randomUUID();
    const jobDir = path.join(paths.jobs, id);
    await fsp.mkdir(jobDir, { recursive: true });
    try {
      await acceptMultipartJob(request, { id, jobDir });
      processQueue().catch((error) => console.error("Local agent queue failed", error));
      return json(response, 202, { jobId: id, status: "queued" }, request, origin);
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
    if (!action && request.method === "GET") return json(response, 200, localJob(job, auth.token), request, origin);
    if (action === "download" && (request.method === "GET" || request.method === "HEAD")) {
      return streamResult(request, response, job, url.searchParams.get("preview") === "1", () => {
        const options = JSON.parse(job.options_json || "{}");
        if (options.retention !== "keep" && url.searchParams.get("preview") !== "1") cleanupJob(id).catch(() => undefined);
      });
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
    let options = {};
    try { options = JSON.parse(job.options_json || "{}"); } catch { /* treat as non-retained */ }
    if (job.status !== "completed" || options.retention !== "keep") return json(response, 404, { error: "This result is not a retained history item." }, request, origin);
    await cleanupJob(id);
    return json(response, 200, { ok: true, deleted: id }, request, origin);
  }

  return json(response, 404, { error: "Agent route not found." }, request, origin);
}

export function getAgentState() {
  return { pairingCode: state.pairingCode, port: state.port, running: Boolean(state.server), agentVersion: AGENT_VERSION, protocolVersion: PROTOCOL_VERSION };
}

export async function startAgentServer({ port = Number(process.env.AGENT_PORT) || DEFAULT_PORT, host = "127.0.0.1" } = {}) {
  if (state.server) return state.server;
  state.port = port;
  await fsp.mkdir(paths.jobs, { recursive: true });
  await writeCapabilities();
  console.log(`Media Toolbox local agent ${AGENT_VERSION} listening on http://${host}:${port}`);
  console.log(`Pairing code: ${state.pairingCode}`);
  state.server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      console.error("Local agent request failed", error);
      if (!response.headersSent) json(response, 500, { error: "The local agent could not complete the request." }, request, originFor(request));
      else response.destroy();
    });
  });
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
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile && fileURLToPath(import.meta.url) === invokedFile) {
  startAgentServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
