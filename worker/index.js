import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument, concatTransformationMatrix, degrees, popGraphicsState, pushGraphicsState, rgb } from "pdf-lib";
import * as fontkit from "fontkit";
import { config, paths, untruncCandidates } from "../lib/config.js";
import { appendJobLog, claimNextJob, deleteJob, failInterruptedJobs, getJob, listExpiredJobs, updateJob } from "../lib/db.js";
import { commandExists, firstAvailable, runCommand } from "../lib/command.js";
import { applyPdfTextEdits } from "../lib/pdf-text-editor.js";
import { applyPdfOcrEdits } from "../lib/pdf-ocr.js";
import { pdfCompressionSettings, rasterizeImageHeavyPdf, recompressPdfImages } from "../lib/pdf-compressor.js";
import { renderPdfToImageArchive } from "../lib/pdf-to-images.js";
import { rotatedImageDrawPlacement } from "../lib/pdf-image-placement.js";
import { layoutPdfTextRuns, textBoxColor, textBoxDrawPlacement, textBoxFontDefinition, textBoxFontName, textBoxTextRuns } from "../lib/pdf-text-box.js";
import { safePdfOutputFilename, validateMediaSourceUrl } from "../lib/job-intake.js";

let sharpPromise;
let shutdownRequested = false;
const bundledFontBytes = new Map();
const bundledFontkitDocuments = new WeakSet();

async function embedTextBoxFont(pdf, textBox) {
  const definition = textBoxFontDefinition(textBox.fontFamily);
  const fontName = textBoxFontName(textBox);
  if (definition.kind === "standard") return pdf.embedFont(fontName);
  if (!bundledFontkitDocuments.has(pdf)) {
    pdf.registerFontkit(fontkit);
    bundledFontkitDocuments.add(pdf);
  }
  let bytes = bundledFontBytes.get(fontName);
  if (!bytes) {
    bytes = await fsp.readFile(path.join(process.cwd(), "public", "fonts", fontName));
    bundledFontBytes.set(fontName, bytes);
  }
  return pdf.embedFont(bytes);
}

async function loadSharp() {
  if (!sharpPromise) sharpPromise = import("sharp").then((module) => module.default || module).catch(() => null);
  return sharpPromise;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireWorkerLock() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const lockPath = paths.workerLock;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
        try {
          const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          if (lock.pid === process.pid) fs.unlinkSync(lockPath);
        } catch { /* the lock was already removed or replaced */ }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let lock = null;
      try { lock = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { /* stale or partially written lock */ }
      if (processIsAlive(Number(lock?.pid))) {
        throw new Error(`Another NativeMedia Agent worker is already running (PID ${lock.pid}).`);
      }
      try { fs.unlinkSync(lockPath); } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("Could not acquire the NativeMedia Agent worker lock.");
}

function stem(filename) {
  return path.basename(filename, path.extname(filename)).replace(/[^a-zA-Z0-9_-]/g, "_") || "media";
}

function extension(filename) {
  return path.extname(filename).slice(1).toLowerCase();
}

function bytes(pathname) {
  return fsp.stat(pathname).then((stat) => stat.size);
}

function update(id, progress, stage, message, warnings) {
  updateJob(id, { progress, stage, message, ...(warnings ? { warnings } : {}) });
  appendJobLog(id, message, "info");
}

function commandFailure(result) {
  const detail = `${result.stderr || ""}\n${result.stdout || ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
  return detail.slice(0, 500) || `process exited with code ${result.code}`;
}

async function refinePdfToTarget(baseBytes, targetBytes, pageCount, compressionOptions, reportProgress) {
  const baseQuality = Math.max(25, Math.min(90, Number(compressionOptions.customQuality) || 72));
  let low = baseBytes.length > targetBytes ? 25 : baseQuality;
  let high = baseBytes.length > targetBytes ? baseQuality : 90;
  let best = { bytes: baseBytes, quality: baseQuality, distance: Math.abs(baseBytes.length - targetBytes) };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (best.distance <= 1_000_000) break;
    const quality = Math.round((low + high) / 2);
    if (quality === low || quality === high) break;
    reportProgress?.(attempt + 1, 6, quality);
    try {
      const document = await PDFDocument.load(baseBytes, { updateMetadata: false, throwOnInvalidObject: false });
      const result = await recompressPdfImages(document, "custom", { compressionOptions: { ...compressionOptions, customQuality: quality } });
      const candidate = result.changed
        ? await document.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 })
        : baseBytes;
      const validation = await PDFDocument.load(candidate, { updateMetadata: false, throwOnInvalidObject: false });
      if (validation.getPageCount() !== pageCount) throw new Error("The target-size PDF page count changed.");
      const distance = Math.abs(candidate.length - targetBytes);
      if (distance < best.distance) best = { bytes: candidate, quality, distance };
      if (candidate.length > targetBytes) high = quality;
      else low = quality;
    } catch {
      break;
    }
  }
  return best;
}

async function usableGhostscript() {
  const candidate = await firstAvailable(["gs"]);
  if (!candidate) return null;
  try {
    // On macOS, an executable can still have a valid mode bit while one of
    // its Homebrew dylib dependencies has been removed. Do not launch such a
    // binary: the dynamic loader can leave the child stuck before it emits an
    // error, which would block a compression job indefinitely.
    if (process.platform === "darwin") {
      const inspection = await runCommand("otool", ["-L", candidate], { timeoutMs: 5000 });
      if (inspection.code !== 0) return null;
      const missing = inspection.stdout
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim().split(" (")[0])
        .filter((dependency) => dependency.startsWith("/") && !fs.existsSync(dependency));
      if (missing.length) return null;
    }
    const result = await runCommand(candidate, ["--version"], { timeoutMs: 5000 });
    return result.code === 0 ? candidate : null;
  } catch {
    return null;
  }
}

function logAttemptFailure(jobId, label, result) {
  if (result.code !== 0) appendJobLog(jobId, `${label} failed: ${commandFailure(result)}`, "warning");
}

function formatProgressBytes(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(amount) / Math.log(1024)), units.length - 1);
  return `${(amount / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function timeToMilliseconds(value) {
  const match = String(value || "").match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return null;
  return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
}

function millisecondsToTime(value) {
  if (!Number.isFinite(value) || value < 0) return "";
  const totalSeconds = value / 1000;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

function cancellationRequested(jobId) {
  return shutdownRequested || Boolean(jobId && getJob(jobId)?.status === "cancelled");
}

async function mediaDuration(ffprobe, file, jobId = "") {
  const result = await runCommand(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], {
    timeoutMs: 120000,
    cancelWhen: () => cancellationRequested(jobId),
  });
  const values = result.stdout.split(/\s+/).map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length) return Math.max(...values) * 1000;

  // Damaged WebM files often lose the duration field even though their packet
  // timestamps are still usable. Scan timestamps without retaining the whole
  // ffprobe response in memory, then use the last video timestamp as a total.
  let packetBuffer = "";
  let lastTimestamp = null;
  const readPacketTimestamps = (chunk) => {
    packetBuffer += chunk;
    const lines = packetBuffer.split(/\r?\n/);
    packetBuffer = lines.pop() || "";
    for (const line of lines) {
      const timestamp = Number(line.match(/^-?\d+(?:\.\d+)?/)?.[0]);
      if (Number.isFinite(timestamp) && timestamp >= 0) lastTimestamp = Math.max(lastTimestamp || 0, timestamp);
    }
  };
  await runCommand(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_packets", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file], {
    timeoutMs: 120000,
    captureStdout: false,
    onStdout: readPacketTimestamps,
    cancelWhen: () => cancellationRequested(jobId),
  });
  readPacketTimestamps("\n");
  return lastTimestamp !== null ? lastTimestamp * 1000 : null;
}

async function runTrackedFfmpeg(ffmpeg, args, jobId, label, durationMs = null) {
  const progress = {};
  let buffer = "";
  let lastLoggedAt = 0;

  updateJob(jobId, {
    conversionProgress: durationMs ? 0 : -1,
    conversionCurrent: "00:00:00.0",
    conversionTotal: durationMs ? millisecondsToTime(durationMs) : "",
  });

  const readProgress = (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const separator = line.indexOf("=");
      if (separator > 0) progress[line.slice(0, separator)] = line.slice(separator + 1).trim();
    }
    if (Date.now() - lastLoggedAt < 2000) return;
    const currentMs = timeToMilliseconds(progress.out_time);
    const conversionProgress = durationMs && currentMs !== null
      ? Math.max(0, Math.min(99, Math.round((currentMs / durationMs) * 100)))
      : -1;
    const details = [
      progress.frame && `frame ${progress.frame}`,
      progress.out_time && progress.out_time !== "N/A" && `time ${progress.out_time}`,
      progress.speed && progress.speed !== "N/A" && `speed ${progress.speed}`,
      progress.total_size && `output ${formatProgressBytes(progress.total_size)}`,
    ].filter(Boolean);
    if (!details.length) return;
    const message = `${label}: ${details.join(" · ")}`;
    updateJob(jobId, {
      message,
      conversionProgress,
      conversionCurrent: currentMs === null ? (progress.out_time || "") : millisecondsToTime(currentMs),
    });
    appendJobLog(jobId, message, "info");
    lastLoggedAt = Date.now();
  };

  const result = await runCommand(ffmpeg, ["-progress", "pipe:2", "-stats_period", "2", ...args], {
    onStderr: readProgress,
    cancelWhen: () => cancellationRequested(jobId),
  });
  if (result.code === 0) updateJob(jobId, { conversionProgress: 100 });
  return result;
}

async function imageMetadata(imageTool, source) {
  const args = ["-format", "%m|%w|%h|%[channels]", `${source}[0]`];
  const result = imageTool === "magick" ? await runCommand(imageTool, ["identify", ...args], { timeoutMs: 15000 }) : await runCommand("identify", args, { timeoutMs: 15000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "The image could not be inspected.");
  const [format, width, height, channels] = result.stdout.trim().split("|");
  return { format: format?.toLowerCase() || "unknown", width: Number(width), height: Number(height), channels: channels || "" };
}

async function sipsMetadata(source) {
  const result = await runCommand("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", "-g", "hasAlpha", source], { timeoutMs: 15000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "The image could not be inspected.");
  const value = (name) => result.stdout.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "mi"))?.[1]?.trim();
  const width = Number(value("pixelWidth"));
  const height = Number(value("pixelHeight"));
  if (!width || !height) throw new Error("The image dimensions could not be read.");
  return { format: value("format")?.toLowerCase() || "unknown", width, height, channels: /^(yes|true)$/i.test(value("hasAlpha") || "") ? "rgba" : "" };
}

async function imageConvert(imageTool, args) {
  const result = await runCommand(imageTool === "magick" ? imageTool : "convert", args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "The image conversion failed.");
}

async function sharpMetadata(source) {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("The bundled image engine is unavailable.");
  const metadata = await sharp(source).metadata();
  if (!metadata.width || !metadata.height) throw new Error("The image dimensions could not be read.");
  return { format: metadata.format || "unknown", width: metadata.width, height: metadata.height, channels: metadata.hasAlpha ? "rgba" : "" };
}

async function sharpConvert(source, destination, targetFormat, quality) {
  const sharp = await loadSharp();
  if (!sharp) throw new Error("The bundled image engine is unavailable.");
  if (targetFormat === "heic") throw new Error("HEIC output needs ImageMagick/libheif or macOS sips on this device.");
  let pipeline = sharp(source);
  if (targetFormat === "jpeg") pipeline = pipeline.jpeg({ quality: quality === undefined ? 90 : quality });
  else if (targetFormat === "png") pipeline = pipeline.png({ compressionLevel: 9 });
  else if (targetFormat === "tiff") pipeline = pipeline.tiff({ quality: quality === undefined ? 90 : quality });
  else if (targetFormat === "gif") pipeline = pipeline.gif();
  else throw new Error(`The bundled image engine cannot create ${targetFormat.toUpperCase()} files.`);
  await pipeline.toFile(destination);
}

async function sipsConvert(source, destination, targetFormat, quality) {
  const args = ["-s", "format", targetFormat];
  if (quality !== undefined) args.push("-s", "formatOptions", String(quality));
  args.push(source, "--out", destination);
  const result = await runCommand("sips", args, { timeoutMs: 15000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "The image conversion failed.");
}

function normalizeImageFormat(format, filename) {
  const value = format.toLowerCase();
  if (value.includes("jpeg") || value === "jpg") return "jpeg";
  if (value.includes("png")) return "png";
  if (value.includes("heic") || value.includes("heif")) return "heic";
  if (value.includes("tiff") || value === "tif") return "tiff";
  if (value.includes("gif")) return "gif";
  if (value.includes("bmp")) return "bmp";
  return extension(filename) || value;
}

function outputExtension(format) {
  return format === "jpeg" ? "jpg" : format === "heic" ? "heic" : format;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paddingForImage(buffer, format, targetBytes) {
  const difference = targetBytes - buffer.length;
  if (difference <= 0) return buffer;

  if (format === "jpeg") {
    const endMarker = Buffer.from([0xff, 0xd9]);
    const end = buffer.lastIndexOf(endMarker);
    const insertAt = end === -1 ? buffer.length : end;
    let remaining = difference;
    const pieces = [];
    while (remaining >= 4) {
      const payloadLength = Math.min(65533, remaining - 4);
      const segment = Buffer.alloc(payloadLength + 4, 0x20);
      segment[0] = 0xff;
      segment[1] = 0xfe;
      segment.writeUInt16BE(payloadLength + 2, 2);
      pieces.push(segment);
      remaining -= segment.length;
    }
    if (!pieces.length) return buffer;
    return Buffer.concat([buffer.subarray(0, insertAt), ...pieces, buffer.subarray(insertAt)]);
  }

  if (format === "png") {
    const type = Buffer.from("tEXt", "ascii");
    const endMarker = Buffer.from("IEND", "ascii");
    const end = buffer.lastIndexOf(endMarker);
    if (end === -1 || difference < 14) return buffer;
    const text = Buffer.alloc(difference - 14, 0x58);
    const data = Buffer.concat([Buffer.from([0x50, 0x00]), text]);
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    type.copy(chunk, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
    return Buffer.concat([buffer.subarray(0, end - 4), chunk, buffer.subarray(end - 4)]);
  }

  if (format === "gif") {
    if (difference < 5) return buffer;
    const blockCount = Math.ceil((difference - 3) / 256);
    const payloadLength = difference - 3 - blockCount;
    const pieces = [Buffer.from([0x21, 0xfe])];
    let remaining = payloadLength;
    for (let index = 0; index < blockCount; index += 1) {
      const slotsLeft = blockCount - index;
      const length = Math.min(255, Math.max(1, remaining - (slotsLeft - 1)));
      pieces.push(Buffer.from([length]), Buffer.alloc(length, 0x58));
      remaining -= length;
    }
    pieces.push(Buffer.from([0x00]));
    const end = buffer.lastIndexOf(Buffer.from([0x3b]));
    const insertAt = end === -1 ? buffer.length : end;
    return Buffer.concat([buffer.subarray(0, insertAt), ...pieces, buffer.subarray(insertAt)]);
  }

  // TIFF, BMP and HEIC readers commonly ignore trailing application padding.
  // The output is validated again after this operation; it is restored if a
  // particular reader rejects the extra bytes.
  return Buffer.concat([buffer, Buffer.alloc(difference)]);
}

async function padImageToTarget(filename, format, targetBytes) {
  const original = await fsp.readFile(filename);
  if (original.length >= targetBytes) return null;
  const padded = paddingForImage(original, format, targetBytes);
  if (padded.length === original.length) return null;
  await fsp.writeFile(filename, padded);
  return { original, bytesAdded: padded.length - original.length };
}

async function processImage(job) {
  const options = JSON.parse(job.options_json);
  const requestedMethod = options.method || "auto";
  if (!["auto", "imagemagick", "sips"].includes(requestedMethod)) throw new Error("Choose a supported processing method.");
  const imageTool = await firstAvailable(["magick", "convert"]);
  const sipsTool = await firstAvailable(["sips"]);
  const sharpTool = await loadSharp();
  if (!imageTool && !sipsTool && !sharpTool) throw new Error("No image conversion engine is available in the worker.");
  if (requestedMethod === "imagemagick" && !imageTool) throw new Error("ImageMagick is not available in this worker.");
  if (requestedMethod === "sips" && !sipsTool) throw new Error("macOS sips is not available in this worker. Select Auto or ImageMagick.");

  const heicSource = ["heic", "heif"].includes(extension(job.source_name));
  const heicTarget = options.format === "heic";
  let processingTool = requestedMethod === "sips"
    ? "sips"
    : requestedMethod === "imagemagick"
      ? imageTool
      : (heicSource || heicTarget || !imageTool) && sipsTool ? "sips" : imageTool || "sharp";
  let metadata;
  try {
    metadata = processingTool === "sips" ? await sipsMetadata(job.source_path) : processingTool === "sharp" ? await sharpMetadata(job.source_path) : await imageMetadata(processingTool, job.source_path);
  } catch (error) {
    if (requestedMethod !== "auto" || processingTool === "sips" || (!sipsTool && !sharpTool)) throw error;
    if (sipsTool) {
      processingTool = "sips";
      metadata = await sipsMetadata(job.source_path);
    } else {
      processingTool = "sharp";
      metadata = await sharpMetadata(job.source_path);
    }
  }
  const inputFormat = normalizeImageFormat(metadata.format, job.source_name);
  const targetFormat = options.format === "original" ? inputFormat : options.format;
  const targetExtension = outputExtension(targetFormat);
  const outputName = `${stem(job.source_name)}_converted.${targetExtension}`;
  const outputPath = path.join(path.dirname(job.source_path), outputName);
  const workDir = path.join(path.dirname(job.source_path), "work");
  await fsp.mkdir(workDir, { recursive: true });
  const warnings = [];
  const hasAlpha = /a|alpha|rgba|hsla/i.test(metadata.channels);

  update(job.id, 15, "Reading source", `${metadata.width} × ${metadata.height} pixels detected.`);
  if (targetFormat === "jpeg" && hasAlpha) {
    warnings.push("JPEG cannot preserve transparency; transparent pixels were flattened against white.");
  }

  const convertArgs = (destination, quality) => {
    const args = [job.source_path];
    if (targetFormat === "jpeg" && hasAlpha) args.push("-background", "white", "-alpha", "remove", "-alpha", "off");
    if (quality !== undefined) args.push("-quality", String(quality));
    args.push(destination);
    return args;
  };
  const convertImage = (destination, quality) => processingTool === "sips"
    ? sipsConvert(job.source_path, destination, targetFormat, quality)
    : processingTool === "sharp"
      ? sharpConvert(job.source_path, destination, targetFormat, quality)
    : imageConvert(processingTool, convertArgs(destination, quality));
  const convertPngPalette = (destination, colors) => imageConvert(processingTool, [
    job.source_path,
    "-strip",
    "-colors",
    String(colors),
    "-dither",
    "None",
    "-define",
    `png:bit-depth=${colors <= 2 ? 1 : colors <= 4 ? 2 : colors <= 16 ? 4 : 8}`,
    "-define",
    "png:compression-level=9",
    "-define",
    "png:compression-filter=5",
    "-define",
    "png:compression-strategy=1",
    `PNG8:${destination}`,
  ]);

  let selectedQuality;
  let selectedPngColors;
  let targetMet;
  // The UI and Finder both display decimal KB: 1 KB = 1,000 bytes.
  const targetBytes = options.maxSizeKb ? options.maxSizeKb * 1000 : undefined;

  if (options.format === "original" && !targetBytes) {
    update(job.id, 45, "Copying source", "No re-encoding was requested.");
    await fsp.copyFile(job.source_path, outputPath);
  } else if (targetBytes && targetFormat === "png" && processingTool !== "sips" && processingTool !== "sharp") {
    update(job.id, 25, "Checking PNG size", "Trying a lossless PNG conversion first.");
    const losslessPath = path.join(workDir, "png-lossless.png");
    await convertImage(losslessPath);
    const losslessBytes = await bytes(losslessPath);
    if (losslessBytes <= targetBytes) {
      await fsp.copyFile(losslessPath, outputPath);
    } else {
      // PNG has no JPEG-style quality setting. Palette reduction is the
      // reliable way to make a photo-sized PNG smaller without resizing it.
      // Start with the most useful palette sizes and keep the largest result
      // that stays at or below the requested maximum.
      update(job.id, 28, "Optimizing PNG size", `The lossless PNG is ${Math.round(losslessBytes / 1000)} KB; reducing colors while keeping ${metadata.width} × ${metadata.height} pixels.`);
      const paletteSizes = [256, 128, 64, 32, 16, 8, 4, 3, 2];
      let bestUnderTarget = null;
      let smallestCandidate = null;
      for (const [index, colors] of paletteSizes.entries()) {
        const candidate = path.join(workDir, `palette-${colors}.png`);
        try {
          await convertPngPalette(candidate, colors);
          const candidateBytes = await bytes(candidate);
          if (!smallestCandidate || candidateBytes < smallestCandidate.bytes) smallestCandidate = { path: candidate, bytes: candidateBytes, colors };
          if (candidateBytes <= targetBytes && (!bestUnderTarget || candidateBytes > bestUnderTarget.bytes)) {
            bestUnderTarget = { path: candidate, bytes: candidateBytes, colors };
          }
          update(job.id, Math.min(78, 30 + Math.round((index + 1) * (48 / paletteSizes.length))), "Optimizing PNG size", `Tested ${colors} colors: ${Math.round(candidateBytes / 1000)} KB.`);
        } catch (error) {
          appendJobLog(job.id, `PNG ${colors}-color optimization failed: ${error.message}`, "warning");
        }
      }
      const selectedCandidate = bestUnderTarget || smallestCandidate;
      if (!selectedCandidate) throw new Error("PNG size optimization failed.");
      await fsp.copyFile(selectedCandidate.path, outputPath);
      selectedPngColors = selectedCandidate.colors;
      if (!bestUnderTarget) {
        warnings.push(`The ${options.maxSizeKb} KB PNG target could not be reached without changing pixel dimensions; the smallest optimized result was kept.`);
      } else if (selectedPngColors < 256) {
        warnings.push(`PNG size targeting reduced the color palette to ${selectedPngColors} colors while preserving the original pixel dimensions. JPG is usually better for photo-sized files.`);
      }
    }
  } else if (targetBytes && (targetFormat === "jpeg" || targetFormat === "heic")) {
    update(job.id, 25, "Searching quality", `Testing ${targetFormat.toUpperCase()} quality from 100 down to 5.`);
    let found = false;
    for (let quality = 100; quality >= 5; quality -= 5) {
      const candidate = path.join(workDir, `quality-${quality}.${targetExtension}`);
      try {
        await convertImage(candidate, quality);
        const candidateBytes = await bytes(candidate);
        if (candidateBytes <= targetBytes) {
          await fsp.copyFile(candidate, outputPath);
          selectedQuality = quality;
          found = true;
          break;
        }
      } catch {
        // Keep testing lower quality levels. A final conversion error is surfaced below.
      }
      update(job.id, Math.min(75, 25 + Math.round((100 - quality) * 0.6)), "Searching quality", `Tested quality ${quality}.`);
    }
    if (!found) {
      selectedQuality = 5;
      const smallest = path.join(workDir, `quality-${selectedQuality}.${targetExtension}`);
      await convertImage(smallest, selectedQuality);
      await fsp.copyFile(smallest, outputPath);
      targetMet = false;
      warnings.push(`The ${options.maxSizeKb} KB target could not be reached without changing pixel dimensions; the smallest tested result was kept.`);
    }
  } else {
    update(job.id, 50, "Converting image", `Writing ${targetFormat.toUpperCase()} output.`);
    await convertImage(outputPath);
  }

  let paddingState = null;
  if (targetBytes && (await bytes(outputPath)) < targetBytes) {
    paddingState = await padImageToTarget(outputPath, targetFormat, targetBytes);
  }
  let outputMetadata;
  try {
    outputMetadata = processingTool === "sips" ? await sipsMetadata(outputPath) : processingTool === "sharp" ? await sharpMetadata(outputPath) : await imageMetadata(processingTool, outputPath);
  } catch (error) {
    if (!paddingState) throw error;
    await fsp.writeFile(outputPath, paddingState.original);
    paddingState = null;
    warnings.push("The requested target could not be padded safely for this image format; the unpadded conversion was kept.");
    outputMetadata = processingTool === "sips" ? await sipsMetadata(outputPath) : processingTool === "sharp" ? await sharpMetadata(outputPath) : await imageMetadata(processingTool, outputPath);
  }
  const outputBytes = await bytes(outputPath);
  if (outputMetadata.width !== metadata.width || outputMetadata.height !== metadata.height) {
    warnings.push(`Output dimensions changed from ${metadata.width} × ${metadata.height} to ${outputMetadata.width} × ${outputMetadata.height}.`);
  }
  if (targetBytes) {
    const nearTargetWindow = Math.max(1024, Math.round(targetBytes * 0.02));
    targetMet = outputBytes <= targetBytes && outputBytes >= targetBytes - nearTargetWindow;
    if (targetMet) warnings.push(`Output is near the requested ${options.maxSizeKb} KB target.`);
    else if (outputBytes < targetBytes) warnings.push(`The output is ${Math.round(outputBytes / 1024)} KB; the ${options.maxSizeKb} KB target could not be reached safely for this format.`);
  }

  const result = {
    path: outputPath,
    filename: outputName,
    bytes: outputBytes,
    inputBytes: await bytes(job.source_path),
    durationMs: null,
    width: outputMetadata.width,
    height: outputMetadata.height,
    quality: selectedQuality,
    pngColors: selectedPngColors,
    targetMet,
    targetSizeKb: options.maxSizeKb,
    inputFormat,
    outputFormat: targetFormat,
    method: options.format === "original" && !targetBytes ? "Original-format copy" : processingTool === "sips" ? "macOS sips fallback" : processingTool === "sharp" ? "Bundled image engine" : "ImageMagick conversion",
  };
  appendJobLog(job.id, `Created ${outputName} successfully.`, "complete");
  updateJob(job.id, { status: "completed", progress: 100, stage: "Complete", message: "The image is ready to download.", warnings, result });
}

function svgBackground(value) {
  return ["color", "gradient"].includes(value) ? value : "transparent";
}

function svgGradientPoint(angle, distance) {
  const radians = (Number(angle || 0) - 90) * Math.PI / 180;
  return {
    x: 50 + Math.cos(radians) * distance,
    y: 50 + Math.sin(radians) * distance,
  };
}

function svgBackgroundMarkup(width, height, options) {
  const opacity = Math.max(0, Math.min(1, Number(options.backgroundOpacity ?? 100) / 100));
  if (svgBackground(options.background) === "color") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${options.backgroundColor}" fill-opacity="${opacity}"/></svg>`;
  }
  const start = svgGradientPoint(options.gradientAngle, 70.71);
  const end = svgGradientPoint(Number(options.gradientAngle || 0) + 180, 70.71);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="background" x1="${start.x}%" y1="${start.y}%" x2="${end.x}%" y2="${end.y}%"><stop offset="0%" stop-color="${options.gradientStartColor}" stop-opacity="${opacity}"/><stop offset="100%" stop-color="${options.gradientEndColor}" stop-opacity="${opacity}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#background)"/></svg>`;
}

async function processSvgToPng(job) {
  const options = JSON.parse(job.options_json || "{}");
  const sharp = await loadSharp();
  if (!sharp) throw new Error("The bundled image engine is unavailable for SVG conversion.");
  const source = await fsp.readFile(job.source_path);
  const metadata = await sharp(source).metadata();
  const intrinsicWidth = Number(metadata.width) || 300;
  const intrinsicHeight = Number(metadata.height) || 150;
  const scale = options.scale === "custom" ? 1 : Number(options.scale) || 1;
  const width = options.scale === "custom" ? Number(options.width) : Math.max(1, Math.round(intrinsicWidth * scale));
  const height = options.scale === "custom" ? Number(options.height) : Math.max(1, Math.round(intrinsicHeight * scale));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 8192 * 8192) throw new Error("The requested SVG output dimensions are not supported.");
  const outputName = `${stem(job.source_name)}.png`;
  const outputPath = path.join(path.dirname(job.source_path), outputName);
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  update(job.id, 20, "Reading SVG", `${intrinsicWidth} × ${intrinsicHeight} vector dimensions detected.`);
  const renderedSource = await sharp(source, { density: 72 })
    .resize({ width, height, fit: options.preserveAspectRatio === false ? "fill" : "contain", background: transparent })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const outputPipeline = svgBackground(options.background) === "transparent"
    ? sharp(renderedSource)
    : sharp(Buffer.from(svgBackgroundMarkup(width, height, options))).composite([{ input: renderedSource, blend: "over" }]);
  await outputPipeline.png({ compressionLevel: 9 }).toFile(outputPath);
  const outputMetadata = await sharp(outputPath).metadata();
  const outputBytes = await bytes(outputPath);
  const result = {
    path: outputPath,
    filename: outputName,
    bytes: outputBytes,
    inputBytes: source.length,
    durationMs: null,
    width: outputMetadata.width || width,
    height: outputMetadata.height || height,
    inputFormat: "svg",
    outputFormat: "png",
    scale: options.scale,
    background: options.background,
    backgroundOpacity: options.backgroundOpacity,
    gradientAngle: options.background === "gradient" ? options.gradientAngle : undefined,
    preserveAspectRatio: options.preserveAspectRatio,
    method: "Bundled image engine · local SVG rasterization",
  };
  appendJobLog(job.id, `Created ${outputName} successfully.`, "complete");
  updateJob(job.id, { status: "completed", progress: 100, stage: "Complete", message: "The PNG is ready to download.", warnings: [], result });
}

function isJpegImage(filename, mime = "") {
  return [".jpg", ".jpeg"].includes(path.extname(filename).toLowerCase()) || mime === "image/jpeg";
}

async function embedPdfImage(pdf, page, workDir, index) {
  const imageExtension = extension(page.imageName || page.imagePath);
  const imageBytes = await fsp.readFile(page.imagePath);
  if (imageExtension === "png" || page.imageMime === "image/png") return pdf.embedPng(imageBytes);
  if (isJpegImage(page.imageName || page.imagePath, page.imageMime)) return pdf.embedJpg(imageBytes);

  const normalizedPath = path.join(workDir, `pdf-image-${index}.png`);
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (imageTool) {
    const command = imageTool === "magick" ? imageTool : "convert";
    const normalized = await runCommand(command, [page.imagePath, "-auto-orient", `png32:${normalizedPath}`]);
    if (normalized.code !== 0 || !fs.existsSync(normalizedPath)) throw new Error(`${page.imageName || "The inserted image"} could not be normalized for PDF embedding.`);
  } else {
    const sharp = await loadSharp();
    if (!sharp) throw new Error(`${page.imageName || "The inserted image"} needs an image engine for PDF embedding.`);
    await sharp(page.imagePath).rotate().png().toFile(normalizedPath);
  }
  return pdf.embedPng(await fsp.readFile(normalizedPath));
}

async function drawPdfImages(pdf, outputPage, operation, workDir, index) {
  const images = Array.isArray(operation.images) ? operation.images : operation.imagePath ? [{ path: operation.imagePath, name: operation.imageName, mime: operation.imageMime, placement: operation.image }] : [];
  const pageWidth = Number(operation.width) || outputPage.getWidth();
  const pageHeight = Number(operation.height) || outputPage.getHeight();
  for (const [imageIndex, imageOperation] of images.entries()) {
    const placement = imageOperation.placement || imageOperation.image;
    const values = [placement?.x, placement?.y, placement?.width, placement?.height, placement?.rotation ?? 0].map(Number);
    if (!placement || !values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0 || values[0] < -100000 || values[1] < -100000 || values[0] + values[2] > 100000 || values[1] + values[3] > 100000) {
      throw new Error(`Image ${imageIndex + 1} has an invalid placement on PDF page.`);
    }
    const image = await embedPdfImage(pdf, { imagePath: imageOperation.path, imageName: imageOperation.name, imageMime: imageOperation.mime }, workDir, `${index}-${imageIndex}`);
    const drawPlacement = rotatedImageDrawPlacement(placement, pageHeight);
    outputPage.drawImage(image, {
      x: drawPlacement.x,
      y: drawPlacement.y,
      width: drawPlacement.width,
      height: drawPlacement.height,
      rotate: degrees(drawPlacement.rotation),
    });
  }
}

async function drawPdfTextBoxes(pdf, outputPage, operation) {
  const textBoxes = Array.isArray(operation.textBoxes) ? operation.textBoxes : [];
  if (!textBoxes.length) return;
  const fontCache = new Map();
  const pageHeight = Number(operation.height) || outputPage.getHeight();
  for (const [index, textBox] of textBoxes.entries()) {
    try {
      const placement = textBoxDrawPlacement(textBox, pageHeight);
      const rotation = Number(textBox.rotation) || 0;
      const radians = rotation * Math.PI / 180;
      const a = Math.cos(radians);
      const b = Math.sin(radians);
      const c = -Math.sin(radians);
      const d = Math.cos(radians);
      const centerX = placement.x + placement.width / 2;
      const centerY = placement.y + placement.height / 2;
      outputPage.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, centerX - a * centerX - c * centerY, centerY - b * centerX - d * centerY));
      if (textBox.backgroundColor !== "transparent") {
        const background = textBoxColor(textBox.backgroundColor, "#ffffff");
        outputPage.drawRectangle({ x: placement.x, y: placement.y, width: placement.width, height: placement.height, color: rgb(background.r, background.g, background.b), borderWidth: 0 });
      }
      if (String(textBox.text ?? "")) {
        const fontCacheForBox = new Map();
        const fontForRun = (run) => fontCacheForBox.get(textBoxFontName(run));
        for (const run of textBoxTextRuns(textBox)) {
          const fontName = textBoxFontName(run);
          if (!fontCacheForBox.has(fontName)) {
            let font = fontCache.get(fontName);
            if (!font) {
              font = await embedTextBoxFont(pdf, run);
              fontCache.set(fontName, font);
            }
            fontCacheForBox.set(fontName, font);
          }
        }
        const lines = layoutPdfTextRuns(textBoxTextRuns(textBox), fontForRun, Math.max(1, placement.width - 8));
        let baseline = placement.y + placement.height - (lines[0]?.height || 21.6) - 4;
        for (const line of lines) {
          let textX = placement.x + 4;
          for (const run of line.items) {
            const color = textBoxColor(run.color);
            if (run.backgroundColor !== "transparent") {
              const background = textBoxColor(run.backgroundColor, "#ffffff");
              outputPage.drawRectangle({ x: textX, y: baseline - run.fontSize * 0.22, width: run.width, height: run.fontSize * 1.2, color: rgb(background.r, background.g, background.b), borderWidth: 0 });
            }
            outputPage.drawText(run.text, { x: textX, y: baseline, size: run.fontSize, font: run.font, color: rgb(color.r, color.g, color.b) });
            if (run.underline) outputPage.drawLine({ start: { x: textX, y: baseline - run.fontSize * 0.08 }, end: { x: textX + run.width, y: baseline - run.fontSize * 0.08 }, thickness: Math.max(0.5, run.fontSize * 0.06), color: rgb(color.r, color.g, color.b) });
            textX += run.width;
          }
          baseline -= line.height;
        }
      }
      outputPage.pushOperators(popGraphicsState());
    } catch (error) {
      throw new Error(`Text box ${index + 1} could not be exported with the selected font. Use a supported PDF font and text.`);
    }
  }
}

async function processPdfEditor(job) {
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(job.source_path, "utf8")); } catch { throw new Error("The PDF editor project could not be read."); }
  if (!Array.isArray(manifest.pdfs) || !Array.isArray(manifest.pages) || manifest.pages.length < 1) throw new Error("The PDF editor project has no pages.");

  update(job.id, 5, "Reading PDFs", manifest.pdfs.length ? `Opening ${manifest.pdfs.length} PDF${manifest.pdfs.length === 1 ? "" : "s"}.` : "Starting a blank-page PDF project.");
  const referencedPdfIndices = new Set(
    manifest.pages
      .filter((operation) => operation?.kind === "source")
      .map((operation) => Number(operation.pdfIndex)),
  );
  const sourceDocuments = [];
  for (const [index, source] of manifest.pdfs.entries()) {
    // Password-protected pages are flattened in the browser before a Local or
    // Server job is submitted. Do not try to open those original encrypted
    // files here when none of their pages are copied directly.
    if (!referencedPdfIndices.has(index)) {
      sourceDocuments.push(null);
      continue;
    }
    try {
      sourceDocuments.push(await PDFDocument.load(await fsp.readFile(source.path)));
    } catch {
      throw new Error(`${source.name || "A PDF"} is encrypted, corrupt, or unsupported.`);
    }
  }

  const outputDocument = await PDFDocument.create();
  const workDir = path.join(path.dirname(job.source_path), "work");
  await fsp.mkdir(workDir, { recursive: true });
  for (let index = 0; index < manifest.pages.length; index += 1) {
    const operation = manifest.pages[index];
    const pageProgress = 10 + Math.round(((index + 1) / manifest.pages.length) * 75);
    if (operation.kind === "source") {
      const sourceDocument = sourceDocuments[operation.pdfIndex];
      if (!sourceDocument || !Number.isInteger(operation.pageIndex) || operation.pageIndex < 0 || operation.pageIndex >= sourceDocument.getPageCount()) throw new Error(`Source page ${index + 1} is no longer available.`);
      const [copiedPage] = await outputDocument.copyPages(sourceDocument, [operation.pageIndex]);
      outputDocument.addPage(copiedPage);
      if ([0, 90, 180, 270].includes(Number(operation.rotation))) copiedPage.setRotation(degrees(Number(operation.rotation)));
      if ((Array.isArray(operation.images) && operation.images.length) || operation.imagePath) await drawPdfImages(outputDocument, copiedPage, operation, workDir, index);
      if (Array.isArray(operation.textBoxes) && operation.textBoxes.length) await drawPdfTextBoxes(outputDocument, copiedPage, operation);
      update(job.id, pageProgress, "Arranging pages", `Added page ${index + 1} of ${manifest.pages.length}.`);
      continue;
    }
    if (operation.kind !== "blank" || !Number.isFinite(operation.width) || !Number.isFinite(operation.height)) throw new Error(`Page ${index + 1} has invalid page details.`);
    const outputPage = outputDocument.addPage([operation.width, operation.height]);
    if ([0, 90, 180, 270].includes(operation.rotation)) outputPage.setRotation(degrees(operation.rotation));
    if ((Array.isArray(operation.images) && operation.images.length) || operation.imagePath) await drawPdfImages(outputDocument, outputPage, operation, workDir, index);
    if (Array.isArray(operation.textBoxes) && operation.textBoxes.length) await drawPdfTextBoxes(outputDocument, outputPage, operation);
    update(job.id, pageProgress, "Arranging pages", `Added page ${index + 1} of ${manifest.pages.length}.`);
  }

  update(job.id, 90, "Writing PDF", "Saving the new merged PDF.");
  const outputStem = manifest.pdfs.length === 1 ? stem(manifest.pdfs[0].name) : manifest.pdfs.length > 1 ? "merged" : "blank_pages";
  const outputName = safePdfOutputFilename(manifest.outputFilename, `${outputStem}_edited.pdf`);
  const outputPath = path.join(path.dirname(job.source_path), outputName);
  await fsp.writeFile(outputPath, await outputDocument.save());
  try {
    const validation = await PDFDocument.load(await fsp.readFile(outputPath));
    if (validation.getPageCount() !== manifest.pages.length) throw new Error("The generated PDF page count does not match the editor project.");
  } catch (error) {
    throw new Error(error instanceof Error && error.message.includes("page count") ? error.message : "The generated PDF could not be validated.");
  }

  const result = { path: outputPath, filename: outputName, bytes: await bytes(outputPath), inputBytes: manifest.pdfs.reduce((total, source) => total + source.size, 0), pageCount: manifest.pages.length, method: "PDF page editor" };
  appendJobLog(job.id, `Created ${outputName} successfully.`, "complete");
  updateJob(job.id, { status: "completed", progress: 100, stage: "Complete", message: "The edited PDF is ready to download.", warnings: [], result });
}

async function processPdfCompressor(job) {
  let options;
  try { options = JSON.parse(job.options_json || "{}"); } catch { throw new Error("The PDF compression options could not be read."); }
  const input = await fsp.readFile(job.source_path);
  let inputDocument;
  try {
    inputDocument = await PDFDocument.load(input, { updateMetadata: false, throwOnInvalidObject: false });
    if (inputDocument.getPageCount() < 1) throw new Error("The PDF has no pages.");
  } catch {
    throw new Error("The PDF is encrypted, corrupt, or unsupported.");
  }

  const profile = options.compressionProfile || "balanced";
  const compressionOptions = {
    customQuality: options.customQuality,
    removeColor: options.removeColor === true || options.removeColor === "1" || options.removeColor === "true",
  };
  const profileSettings = pdfCompressionSettings(profile, compressionOptions);
  if (!profileSettings) throw new Error("Choose a supported compression level.");
  const settings = {
    ...profileSettings,
    pdfSettings: { balanced: "ebook", small: "screen", quality: "prepress", custom: null }[profile],
  };
  const customTargetMb = profile === "custom" && options.customTargetMb !== "" ? Number(options.customTargetMb) : 0;
  const targetBytes = Number.isFinite(customTargetMb) && customTargetMb >= 1 ? Math.round(customTargetMb * 1000 * 1000) : 0;
  const outputName = safePdfOutputFilename(options.outputFilename, `${stem(job.source_name)}_compressed.pdf`);
  const jobDir = path.dirname(job.source_path);
  const outputPath = path.join(jobDir, outputName);
  const workPath = path.join(jobDir, `${outputName}.working`);
  const warnings = [];
  let bestBytes = null;
  let method = "";
  let targetCandidate = null;
  let visualCandidate = null;

  const chooseCandidate = async (candidate, candidateMethod) => {
    try {
      const validation = await PDFDocument.load(candidate, { updateMetadata: false, throwOnInvalidObject: false });
      if (validation.getPageCount() !== inputDocument.getPageCount()) throw new Error("The compressed PDF page count changed.");
      if (targetBytes && (!targetCandidate || Math.abs(candidate.length - targetBytes) < targetCandidate.distance)) {
        targetCandidate = { bytes: candidate, method: candidateMethod, distance: Math.abs(candidate.length - targetBytes) };
      }
      if (!bestBytes || candidate.length < bestBytes.length) {
        bestBytes = candidate;
        method = candidateMethod;
      }
      return true;
    } catch (error) {
      appendJobLog(job.id, `${candidateMethod} failed validation: ${error instanceof Error ? error.message : "invalid PDF"}`, "warning");
      return false;
    }
  };

  update(job.id, 10, "Inspecting PDF", `Opening ${inputDocument.getPageCount()} page${inputDocument.getPageCount() === 1 ? "" : "s"}.`);
  await fsp.rm(workPath, { force: true });
  const ghostscript = settings.pdfSettings ? await usableGhostscript() : null;
  if (ghostscript) {
    update(job.id, 28, "Compressing PDF", `${settings.label} with Ghostscript.`);
    const compressed = await runCommand(ghostscript, [
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.4",
      `-dPDFSETTINGS=/${settings.pdfSettings}`,
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-dNOPAUSE",
      "-dBATCH",
      "-dSAFER",
      `-sOutputFile=${workPath}`,
      job.source_path,
    ], { timeoutMs: 15 * 60 * 1000 });
    if (compressed.code === 0 && fs.existsSync(workPath)) {
      await chooseCandidate(await fsp.readFile(workPath), `Ghostscript ${settings.label.toLowerCase()}`);
    } else {
      appendJobLog(job.id, `Ghostscript compression failed: ${commandFailure(compressed)}`, "warning");
      warnings.push("The optional Ghostscript optimizer could not complete on this worker; the bundled optimizer was used instead.");
    }
  }

  update(job.id, 42, "Optimizing PDF structure", "Rewriting the PDF with compressed object streams.");
  const rewritten = await inputDocument.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
  await chooseCandidate(rewritten, "PDF structural optimization");

  update(job.id, 56, "Compressing embedded images", "Re-encoding eligible page images while preserving text and vector content.");
  try {
    const imageDocument = await PDFDocument.load(input, { updateMetadata: false, throwOnInvalidObject: false });
    let lastImageProgress = 0;
    const imageResult = await recompressPdfImages(imageDocument, profile, {
      compressionOptions,
      onProgress: (done, total) => {
        if (!total) return;
        const progress = Math.min(78, 56 + Math.round((done / total) * 22));
        if (progress <= lastImageProgress) return;
        lastImageProgress = progress;
        updateJob(job.id, progress, "Compressing embedded images", `Re-encoding image ${done} of ${total}.`);
      },
    });
    if (imageResult.changed) {
      const imageBytes = await imageDocument.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
      await chooseCandidate(imageBytes, `Bundled image recompression (${imageResult.replacements} image${imageResult.replacements === 1 ? "" : "s"})`);
      appendJobLog(job.id, `Re-encoded ${imageResult.replacements} embedded image${imageResult.replacements === 1 ? "" : "s"}; preserved ${imageResult.skipped} image${imageResult.skipped === 1 ? "" : "s"}.`, "info");
    } else if (imageResult.reason) {
      warnings.push("The bundled image engine was unavailable; structural PDF optimization was used instead.");
    } else {
      appendJobLog(job.id, "No eligible embedded images needed re-encoding.", "info");
    }
  } catch (error) {
    appendJobLog(job.id, `Bundled image recompression was skipped: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
    warnings.push("Some embedded images could not be re-encoded; the best validated PDF pass was used instead.");
  }

  // PDFs made from scans are often image-only or image-heavy but use a codec
  // (JPX, CCITT, JBIG2, or inline image data) that pdf-lib cannot safely
  // decode. Always evaluate the visual pass so the page-aware browser
  // estimate and the submitted result use the same candidate path. The
  // rasterizer returns unchanged for text/vector-only documents, and the
  // candidate selector keeps the smaller validated result when direct image
  // compression is already better. Rasterized searchable pages receive an
  // invisible text overlay.
  if (bestBytes) {
    update(job.id, 80, "Applying visual compression", "Checking image-heavy pages for a page-aware compression pass.");
    try {
      const rasterResult = await rasterizeImageHeavyPdf(input, profile, {
        compressionOptions,
        onProgress: (done, total) => {
          if (!total) return;
          const progress = Math.min(88, 80 + Math.round((done / total) * 8));
          updateJob(job.id, { progress, stage: "Applying visual compression", message: `Optimizing page ${done} of ${total}.` });
        },
      });
      if (rasterResult.changed) {
        const visualMethod = `Bundled visual page recompression (${rasterResult.pageCount} pages)`;
        visualCandidate = { bytes: rasterResult.bytes, method: visualMethod, quality: Number(compressionOptions.customQuality) || 72 };
        await chooseCandidate(rasterResult.bytes, visualMethod);
        const pageLabel = rasterResult.imageOnly ? "image-only" : "image-heavy";
        appendJobLog(job.id, `Rebuilt ${rasterResult.rasterizedPages || rasterResult.pageCount} ${pageLabel} page${(rasterResult.rasterizedPages || rasterResult.pageCount) === 1 ? "" : "s"} at the selected quality${rasterResult.overlaidText ? "; retained a searchable text overlay" : ""}.`, "info");
        warnings.push(rasterResult.imageOnly
          ? "This PDF had no searchable text, so the aggressive image-only pass rebuilt its pages as optimized images. The visual layout is preserved, but text is not selectable in this result."
          : `The aggressive image-heavy pass rebuilt ${rasterResult.rasterizedPages} page${rasterResult.rasterizedPages === 1 ? "" : "s"} as optimized images. Searchable text was retained as an invisible text layer; vector styling on those pages is visually approximated.`);
      } else if (rasterResult.pageCount) {
        appendJobLog(job.id, rasterResult.imageOnly === false && rasterResult.reason === "no image-heavy pages"
          ? "Visual page compression was skipped because no image-heavy pages were detected; text and vector content were preserved."
          : "Visual page compression was skipped because no eligible pages were found.", "info");
      } else if (rasterResult.reason) {
        appendJobLog(job.id, `Visual page compression was skipped: ${rasterResult.reason}`, "warning");
      }
    } catch (error) {
      appendJobLog(job.id, `Visual page compression was skipped: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
    }
  }

  if (targetBytes && targetBytes < input.length) {
    let targetBase = visualCandidate
      ? { ...visualCandidate, distance: Math.abs(visualCandidate.bytes.length - targetBytes) }
      : targetCandidate || (bestBytes ? { bytes: bestBytes, method, distance: Math.abs(bestBytes.length - targetBytes) } : null);
    if (targetBase && targetBytes > targetBase.bytes.length && visualCandidate) {
      update(job.id, 87, "Tuning custom target", "The first visual pass is smaller than the requested target; trying a higher-quality pass.");
      try {
        const higherQuality = await rasterizeImageHeavyPdf(input, "custom", {
          compressionOptions: { ...compressionOptions, customQuality: 90 },
          onProgress: (done, total) => {
            if (!total) return;
            updateJob(job.id, { progress: Math.min(89, 87 + Math.round((done / total) * 2)), stage: "Tuning custom target", message: `Rebuilding target sample ${done} of ${total}.` });
          },
        });
        if (higherQuality.changed) {
          const higherMethod = `Custom target high-quality pass (${higherQuality.pageCount} pages)`;
          await chooseCandidate(higherQuality.bytes, higherMethod);
          const higherDistance = Math.abs(higherQuality.bytes.length - targetBytes);
          if (higherDistance < targetBase.distance) targetBase = { bytes: higherQuality.bytes, method: higherMethod, distance: higherDistance, quality: 90 };
        }
      } catch (error) {
        appendJobLog(job.id, `Higher-quality custom target pass was skipped: ${error instanceof Error ? error.message : "unknown error"}`, "warning");
      }
    }
    if (targetBase) {
      const refined = await refinePdfToTarget(targetBase.bytes, targetBytes, inputDocument.getPageCount(), { ...compressionOptions, customQuality: targetBase.quality || compressionOptions.customQuality }, (attempt, total, quality) => {
        update(job.id, Math.min(89, 87 + Math.round((attempt / total) * 2)), "Tuning custom target", `Trying image quality ${quality} for the requested size.`);
      });
      if (refined && (!targetCandidate || refined.distance < targetCandidate.distance)) {
        targetCandidate = { bytes: refined.bytes, method: `Custom target tuning (image quality ${refined.quality})`, distance: refined.distance };
      }
    }
    if (targetCandidate) {
      bestBytes = targetCandidate.bytes;
      method = targetCandidate.method;
      const targetDifference = Math.abs(targetCandidate.bytes.length - targetBytes);
      appendJobLog(job.id, `Custom target ${customTargetMb} MB selected the nearest validated result at ${(targetCandidate.bytes.length / 1000 / 1000).toFixed(1)} MB.`, "info");
      if (targetDifference > 1_000_000) warnings.push(`The requested ${customTargetMb} MB target could not be reached within 1 MB; the nearest validated result was ${(targetCandidate.bytes.length / 1000 / 1000).toFixed(1)} MB.`);
    }
  }

  update(job.id, 90, "Validating PDF", "Checking that every page remains readable.");
  if (!bestBytes) throw new Error("The compressed PDF could not be validated.");
  let outputBytes = bestBytes;
  await fsp.writeFile(workPath, outputBytes);

  const inputBytes = input.length;
  if (outputBytes.length >= inputBytes) {
    await fsp.copyFile(job.source_path, workPath);
    outputBytes = input;
    warnings.push("This PDF was already optimized; the original bytes were kept because the selected compression pass would not reduce its size.");
    method = `${method} · original retained`;
  }
  await fsp.rename(workPath, outputPath);
  const savedBytes = Math.max(0, inputBytes - outputBytes.length);
  const reductionPercent = inputBytes ? Math.round((savedBytes / inputBytes) * 100) : 0;
  const result = {
    path: outputPath,
    filename: outputName,
    bytes: outputBytes.length,
    inputBytes,
    savedBytes,
    reductionPercent,
    pageCount: inputDocument.getPageCount(),
    method,
  };
  appendJobLog(job.id, `Created ${outputName} successfully (${reductionPercent}% smaller).`, "complete");
  updateJob(job.id, { status: "completed", progress: 100, stage: "Complete", message: reductionPercent ? `The PDF was compressed by ${reductionPercent}%.` : "The PDF was already optimized; a validated copy is ready.", warnings, result });
}

async function processPdfTextEditor(job) {
  let options;
  try { options = JSON.parse(job.options_json || "{}"); } catch { throw new Error("The PDF text editor options could not be read."); }
  const input = await fsp.readFile(job.source_path);
  const ocrEdits = (options.edits || []).filter((edit) => edit.mode === "ocr");
  const nativeEdits = (options.edits || []).filter((edit) => edit.mode !== "ocr");
  const isOcr = Boolean(options.ocr || ocrEdits.length);
  update(job.id, 8, isOcr ? "Reading OCR text" : "Reading PDF text", isOcr ? "Verifying the selected OCR regions against the original PDF." : "Verifying the selected text runs against the original PDF.");
  let lastReadProgress = 8;
  const reportReadProgress = (progress) => {
    const nextProgress = Math.max(lastReadProgress, Math.min(75, Number(progress) || lastReadProgress));
    if (nextProgress - lastReadProgress < 5 && nextProgress < 75) return;
    lastReadProgress = nextProgress;
    update(job.id, nextProgress, isOcr ? "Reading OCR text" : "Reading PDF text", isOcr ? "Verifying the selected OCR regions against the original PDF." : "Verifying the selected text runs against the original PDF.");
  };
  let edited;
  if (ocrEdits.length && nativeEdits.length) {
    const native = await applyPdfTextEdits(input, nativeEdits, { password: Boolean(options.passwordProvided), onProgress: reportReadProgress });
    const ocr = await applyPdfOcrEdits(native.bytes, ocrEdits, { runSourceHash: options.sourceHash, password: Boolean(options.passwordProvided) });
    edited = { bytes: ocr.bytes, warnings: [...native.warnings, ...ocr.warnings] };
  } else if (ocrEdits.length || options.ocr) {
    edited = await applyPdfOcrEdits(input, ocrEdits.length ? ocrEdits : options.edits, { sourceHash: options.sourceHash, password: Boolean(options.passwordProvided) });
  } else {
    edited = await applyPdfTextEdits(input, nativeEdits, { password: Boolean(options.passwordProvided), onProgress: reportReadProgress });
  }
  update(job.id, 82, "Writing PDF", isOcr ? "Rebuilding only the edited OCR page regions." : "Replacing the selected text operators without rasterizing the document.", edited.warnings);
  const outputName = safePdfOutputFilename(options.outputFilename, `${stem(job.source_name)}_${isOcr ? "ocr_text" : "text"}_edited.pdf`);
  const outputPath = path.join(path.dirname(job.source_path), outputName);
  await fsp.writeFile(outputPath, edited.bytes);
  let outputDocument;
  try {
    outputDocument = await PDFDocument.load(edited.bytes, { updateMetadata: false, throwOnInvalidObject: false });
    if (outputDocument.getPageCount() < 1) throw new Error("The edited PDF has no pages.");
  } catch {
    throw new Error("The edited PDF could not be validated.");
  }
  const result = {
    path: outputPath,
    filename: outputName,
    bytes: await bytes(outputPath),
    inputBytes: input.length,
    pageCount: outputDocument.getPageCount(),
    editCount: options.edits.length,
    method: isOcr ? "PDF OCR text editor" : "PDF text editor",
  };
  appendJobLog(job.id, `Created ${outputName} successfully.`, "complete");
  updateJob(job.id, { status: "completed", progress: 100, stage: "Complete", message: "The edited PDF is ready to download.", warnings: edited.warnings, result });
}

async function probe(ffprobe, file) {
  return runCommand(ffprobe, ["-v", "error", "-i", file]);
}

async function decodes(ffmpeg, file, stream) {
  // FFmpeg's normal error handling is intentionally tolerant and may return
  // exit code 0 after concealing corrupt H.264 frames. -xerror makes a
  // candidate fail validation as soon as decoding reports a real error.
  return runCommand(ffmpeg, ["-hide_banner", "-nostdin", "-xerror", "-v", "error", "-i", file, "-map", `0:${stream}:0`, "-f", "null", "-"]);
}

async function hasAudio(ffprobe, file) {
  const result = await runCommand(ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", file]);
  return result.code === 0 && result.stdout.trim().length > 0;
}

async function usableCandidate(ffmpeg, ffprobe, file, jobId, label) {
  const probed = await probe(ffprobe, file);
  if (probed.code !== 0) {
    if (jobId) appendJobLog(jobId, `${label || "Candidate"} rejected: ffprobe could not read the output.`, "warning");
    return false;
  }
  const video = await decodes(ffmpeg, file, "v");
  if (video.code !== 0) {
    if (jobId) appendJobLog(jobId, `${label || "Candidate"} rejected: H.264 video decoding reported corrupt frames. ${commandFailure(video)}`, "warning");
    return false;
  }
  if (await hasAudio(ffprobe, file)) {
    const audio = await decodes(ffmpeg, file, "a");
    if (audio.code !== 0) {
      if (jobId) appendJobLog(jobId, `${label || "Candidate"} rejected: audio decoding failed. ${commandFailure(audio)}`, "warning");
      return false;
    }
  }
  return true;
}

async function transcodeRecoveredCandidate(ffmpeg, ffprobe, source, destination, jobId, label) {
  const durationMs = await mediaDuration(ffprobe, source, jobId);
  const result = await runTrackedFfmpeg(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err", "-i", source, "-map", "0:v:0?", "-map", "0:a:0?", "-map_metadata", "0", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", destination], jobId, label, durationMs);
  logAttemptFailure(jobId, label, result);
  return result.code === 0 && (await usableCandidate(ffmpeg, ffprobe, destination, jobId, label));
}

async function processVideo(job) {
  const options = JSON.parse(job.options_json);
  const ffmpeg = await firstAvailable(["ffmpeg"]);
  const ffprobe = await firstAvailable(["ffprobe"]);
  if (!ffmpeg || !ffprobe) throw new Error("FFmpeg and ffprobe are required in the worker image.");
  const mkvmerge = await firstAvailable(["mkvmerge"]);
  const untrunc = await firstAvailable(untruncCandidates);
  const configuredReference = fs.existsSync(config.untruncReferencePath) ? config.untruncReferencePath : null;
  const jobDir = path.dirname(job.source_path);
  const workDir = path.join(jobDir, "work");
  await fsp.mkdir(workDir, { recursive: true });
  const outputName = `${stem(job.source_name)}_repaired.mp4`;
  const outputPath = path.join(jobDir, outputName);
  const warnings = [];
  let method = "";
  let rejectedRecoveredVideo = false;
  const sourceDurationMs = await mediaDuration(ffprobe, job.source_path, job.id);

  update(job.id, 8, "Inspecting video", "Checking whether the container can be read.");
  const sourceProbe = await runCommand(ffprobe, ["-v", "error", job.source_path]);
  if (sourceProbe.code !== 0) {
    appendJobLog(job.id, `Container probe failed: ${commandFailure(sourceProbe)}`, "warning");
  }
  if (sourceProbe.code === 0) {
    update(job.id, 18, "Trying lossless remux", "Repairing indexes and timestamps without re-encoding.");
    const candidate = path.join(workDir, "remux.mp4");
    const result = await runTrackedFfmpeg(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err", "-i", job.source_path, "-map", "0:v:0?", "-map", "0:a:0?", "-map_metadata", "0", "-c", "copy", "-movflags", "+faststart", candidate], job.id, "Lossless FFmpeg remux", sourceDurationMs);
    logAttemptFailure(job.id, "Lossless FFmpeg remux", result);
    if (result.code === 0 && (await usableCandidate(ffmpeg, ffprobe, candidate, job.id, "Lossless FFmpeg remux"))) {
      await fsp.rename(candidate, outputPath);
      method = "Lossless FFmpeg remux";
    }
  }

  const inputExtension = extension(job.source_name);
  if (!method && (inputExtension === "mkv" || inputExtension === "webm") && mkvmerge) {
    update(job.id, 30, "Repairing Matroska container", "Rebuilding the MKV/WebM container before remuxing.");
    const repaired = path.join(workDir, `repaired.${inputExtension}`);
    const remux = path.join(workDir, "matroska-remux.mp4");
    const rebuilt = await runCommand(mkvmerge, ["-o", repaired, job.source_path]);
    logAttemptFailure(job.id, "MKVToolNix container rebuild", rebuilt);
    const remuxed = await runTrackedFfmpeg(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err", "-i", repaired, "-map", "0:v:0?", "-map", "0:a:0?", "-map_metadata", "0", "-c", "copy", "-movflags", "+faststart", remux], job.id, "Matroska lossless remux", sourceDurationMs);
    logAttemptFailure(job.id, "Matroska lossless remux", remuxed);
    if (rebuilt.code === 0 && remuxed.code === 0 && (await usableCandidate(ffmpeg, ffprobe, remux, job.id, "Matroska lossless remux"))) {
      await fsp.rename(remux, outputPath);
      method = "MKVToolNix container repair and lossless remux";
    }
  }

  const mp4Family = new Set(["mp4", "m4v", "mov", "3gp"]);
  const referencePath = job.reference_path || configuredReference;
  if (!method && mp4Family.has(inputExtension) && !referencePath) {
    appendJobLog(job.id, "No healthy reference video was supplied; reference-based MP4 recovery was skipped.", "warning");
  }
  if (!method && mp4Family.has(inputExtension) && !untrunc) {
    appendJobLog(job.id, "Untrunc is not installed or configured; missing MP4 metadata cannot be rebuilt by FFmpeg alone.", "warning");
  }
  if (!method && mp4Family.has(inputExtension) && referencePath && untrunc) {
    update(job.id, 42, "Trying reference recovery", job.reference_path
      ? "Using the uploaded healthy reference video to rebuild missing MP4 metadata."
      : "Using the configured healthy reference video to rebuild missing MP4 metadata.");
    const brokenCopy = path.join(workDir, `broken.${inputExtension}`);
    await fsp.copyFile(job.source_path, brokenCopy);
    const untruncAttempts = [
      { args: ["-n", referencePath, brokenCopy], label: "Untrunc reference recovery", suffix: "_fixed.mp4" },
      { args: ["-n", "-sv", referencePath, brokenCopy], label: "Untrunc reference recovery with timing stretch", suffix: "_fixed-sv.mp4" },
    ];
    for (const attempt of untruncAttempts) {
      const recovered = `${brokenCopy}${attempt.suffix}`;
      await fsp.rm(recovered, { force: true });
      const repaired = await runCommand(untrunc, attempt.args);
      logAttemptFailure(job.id, attempt.label, repaired);
      if (repaired.code === 0 && fs.existsSync(recovered)) {
        const candidateUsable = await usableCandidate(ffmpeg, ffprobe, recovered, job.id, attempt.label);
        if (candidateUsable) {
          await fsp.rename(recovered, outputPath);
          method = attempt.suffix.includes("-sv") ? "Reference-based Untrunc recovery with video timing stretch" : "Reference-based Untrunc recovery";
          break;
        }
        update(job.id, 50, "Re-encoding recovered video", "Untrunc rebuilt the container; writing a fresh H.264/AAC MP4 from the decodable frames.");
        const salvaged = path.join(workDir, `untrunc-${attempt.suffix.includes("-sv") ? "sv-" : ""}salvaged.mp4`);
        await fsp.rm(salvaged, { force: true });
        if (await transcodeRecoveredCandidate(ffmpeg, ffprobe, recovered, salvaged, job.id, `${attempt.label} H.264/AAC salvage`)) {
          await fsp.rename(salvaged, outputPath);
          method = attempt.suffix.includes("-sv") ? "Reference recovery plus H.264/AAC transcode with video timing stretch" : "Reference recovery plus H.264/AAC transcode";
          warnings.push("The reference rebuilt the missing MP4 metadata, then the recovered frames were re-encoded into a fresh playable H.264/AAC file.");
          warnings.push("The recovered H.264 stream reported damaged frames. Missing picture data cannot be reconstructed, so review the preview for frozen, blank, or corrupted sections.");
          break;
        }
        rejectedRecoveredVideo = true;
      }
    }
  }

  if (!method) {
    update(job.id, 58, "Trying tolerant conversion", "Decoding what can be recovered into a fresh H.264/AAC MP4.");
    const transcoded = path.join(workDir, "transcoded.mp4");
    const result = await runTrackedFfmpeg(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err", "-i", job.source_path, "-map", "0:v:0?", "-map", "0:a:0?", "-map_metadata", "0", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", transcoded], job.id, "Tolerant H.264/AAC conversion", sourceDurationMs);
    logAttemptFailure(job.id, "Tolerant H.264/AAC conversion", result);
    if (result.code === 0 && (await usableCandidate(ffmpeg, ffprobe, transcoded, job.id, "Tolerant H.264/AAC conversion"))) {
      await fsp.rename(transcoded, outputPath);
      method = "Tolerant H.264/AAC conversion";
    }
  }

  if (!method) {
    update(job.id, 78, "Trying video-only recovery", "Audio could not be preserved cleanly; attempting to save playable video.");
    const videoOnly = path.join(workDir, "video-only.mp4");
    const result = await runTrackedFfmpeg(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-fflags", "+genpts+discardcorrupt", "-err_detect", "ignore_err", "-i", job.source_path, "-map", "0:v:0", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoOnly], job.id, "Video-only H.264 recovery", sourceDurationMs);
    logAttemptFailure(job.id, "Video-only H.264 recovery", result);
    if (result.code === 0 && (await usableCandidate(ffmpeg, ffprobe, videoOnly, job.id, "Video-only H.264 recovery"))) {
      await fsp.rename(videoOnly, outputPath);
      method = "Video-only H.264 recovery";
      warnings.push("Audio could not be recovered cleanly and was omitted.");
    }
  }

  if (!method || !fs.existsSync(outputPath)) {
    throw new Error(rejectedRecoveredVideo
      ? "Reference recovery rebuilt the MP4 container, but strict H.264 validation found corrupt video frames. No playable result was created; try a healthy reference recorded with the exact same settings or re-download/export the original."
      : referencePath || untrunc
      ? "No repair method could decode enough of this file. The container may be missing metadata or contain damaged media data."
      : "This MP4 could not be repaired because its container metadata is missing or unreadable. Upload a matching healthy reference video, and install/configure Untrunc for reference-based recovery.");
  }
  const outputBytes = await bytes(outputPath);
  const result = {
    path: outputPath,
    filename: outputName,
    bytes: outputBytes,
    inputBytes: await bytes(job.source_path),
    durationMs: sourceDurationMs,
    method,
  };
  appendJobLog(job.id, `Created ${outputName} successfully.`, "complete");
  updateJob(job.id, { status: "completed", progress: 100, stage: "Complete", message: "The repaired video is ready to download.", warnings, result });
}

const videoCompressionSettings = {
  balanced: { crf: 23, preset: "medium", maxWidth: 1920, label: "Balanced" },
  small: { crf: 28, preset: "fast", maxWidth: 1280, label: "Small file" },
  quality: { crf: 20, preset: "medium", maxWidth: 3840, label: "Higher quality" },
};

async function processVideoCompressor(job) {
  const options = JSON.parse(job.options_json || "{}");
  const ffmpeg = await firstAvailable(["ffmpeg"]);
  const ffprobe = await firstAvailable(["ffprobe"]);
  if (!ffmpeg || !ffprobe) throw new Error("FFmpeg and ffprobe are required for video compression.");
  const settings = videoCompressionSettings[options.compressionProfile] || videoCompressionSettings.balanced;
  const jobDir = path.dirname(job.source_path);
  const outputName = safeOutputName(options.outputFilename, `${stem(job.source_name)}_compressed.mp4`);
  const outputPath = path.join(jobDir, outputName);
  update(job.id, 8, "Inspecting video", "Reading video streams and duration before compression.");
  const durationMs = await mediaDuration(ffprobe, job.source_path, job.id);
  const args = [
    "-y", "-hide_banner", "-nostdin", "-v", "error", "-i", job.source_path,
    "-map", "0:v:0?", "-map", "0:a:0?", "-map_metadata", "0",
    "-c:v", "libx264", "-preset", settings.preset, "-crf", String(settings.crf), "-pix_fmt", "yuv420p",
    "-vf", `scale=w='min(iw,${settings.maxWidth})':h=-2`,
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", outputPath,
  ];
  update(job.id, 20, "Compressing video", `${settings.label} compression is creating a new MP4.`);
  const result = await runTrackedFfmpeg(ffmpeg, args, job.id, "Video compression", durationMs);
  logAttemptFailure(job.id, "Video compression", result);
  if (result.code !== 0 || !fs.existsSync(outputPath) || !(await usableCandidate(ffmpeg, ffprobe, outputPath, job.id, "Video compression"))) {
    throw new Error(`Video compression could not create a playable result. ${commandFailure(result)}`);
  }
  const outputBytes = await bytes(outputPath);
  const inputBytes = await bytes(job.source_path);
  const output = { path: outputPath, filename: outputName, bytes: outputBytes, inputBytes, durationMs, compressionProfile: options.compressionProfile || "balanced", reductionPercent: Math.max(0, Math.round((1 - outputBytes / inputBytes) * 100)), method: "FFmpeg H.264/AAC compression" };
  appendJobLog(job.id, `Created ${outputName} successfully.`, "complete");
  updateJob(job.id, { status: "completed", progress: 100, stage: "Complete", message: "The compressed video is ready to download.", warnings: outputBytes >= inputBytes ? ["The compressed file is not smaller than the source. The original was left untouched."] : [], result: output });
}

async function downloadAudioSource(job, sourceUrl) {
  const publicMediaDownloader = await firstAvailable(["yt-dlp"]);
  if (!publicMediaDownloader) throw new Error("URL audio extraction requires the public media downloader to be installed for this Server or Local-agent runtime.");
  const validatedUrl = validateMediaSourceUrl(sourceUrl);
  const jobDir = path.dirname(job.source_path);
  const template = path.join(jobDir, "downloaded-source.%(ext)s");
  let lastProgress = -1;
  let lastLoggedAt = 0;
  update(job.id, 4, "Downloading audio source", "Fetching the selected media source with the public media downloader.");
  updateJob(job.id, { conversionProgress: -1, conversionCurrent: "Downloading source", conversionTotal: "" });
  const result = await runCommand(publicMediaDownloader, [
    "--no-playlist",
    "--newline",
    "--progress",
    "--no-warnings",
    "--restrict-filenames",
    "--max-filesize",
    `${Math.ceil(config.videoMaxBytes / (1024 * 1024 * 1024))}G`,
    "-f",
    // Prefer a directly downloadable M4A stream. Some media sites expose a
    // WebM stream first even when that stream is currently rejected with 403.
    "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio",
    "-o",
    template,
    validatedUrl,
  ], {
    onStderr: (chunk) => {
      const match = chunk.match(/(\d+(?:\.\d+)?)%/);
      if (!match) return;
      const percent = Math.max(0, Math.min(100, Math.round(Number(match[1]))));
      if (percent === lastProgress && Date.now() - lastLoggedAt < 2000) return;
      lastProgress = percent;
      const progress = Math.max(4, Math.min(22, 4 + Math.round(percent * 0.18)));
      const message = `Downloading audio source: ${percent}%`;
      updateJob(job.id, { progress, stage: "Downloading audio source", message });
      if (Date.now() - lastLoggedAt >= 2000 || percent === 100) {
        appendJobLog(job.id, message, "info");
        lastLoggedAt = Date.now();
      }
    },
    cancelWhen: () => cancellationRequested(job.id),
  });
  if (result.code !== 0) {
    const detail = commandFailure(result).replaceAll(validatedUrl, "[source URL]");
    if (result.code === 125) throw new Error("URL audio extraction was canceled.");
    if (/HTTP Error 403|403 Forbidden/i.test(detail)) {
      throw new Error("The media site rejected the selected stream (HTTP 403). Update the public media downloader and try again.");
    }
    throw new Error(`The media audio source could not be downloaded. ${detail}`);
  }
  const entries = await fsp.readdir(jobDir, { withFileTypes: true });
  const downloaded = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith("downloaded-source.") && !entry.name.endsWith(".part"))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!downloaded.length) throw new Error("The public media downloader completed without creating an audio source.");
  const sourcePath = path.join(jobDir, downloaded[downloaded.length - 1].name);
  appendJobLog(job.id, "Audio source downloaded. Starting audio extraction.", "info");
  return sourcePath;
}

async function processAudioExtractor(job) {
  const options = JSON.parse(job.options_json || "{}");
  const ffmpeg = await firstAvailable(["ffmpeg"]);
  const ffprobe = await firstAvailable(["ffprobe"]);
  if (!ffmpeg || !ffprobe) throw new Error("FFmpeg and ffprobe are required for audio extraction.");
  const format = ["mp3", "wav", "aac", "flac", "m4a"].includes(options.audioFormat) ? options.audioFormat : "mp3";
  const bitrate = ["128k", "192k", "256k"].includes(options.audioBitrate) ? options.audioBitrate : "192k";
  const sourcePath = options.sourceUrl ? await downloadAudioSource(job, options.sourceUrl) : job.source_path;
  if (!(await hasAudio(ffprobe, sourcePath))) throw new Error("This video does not contain an audio track to extract.");
  const jobDir = path.dirname(job.source_path);
  const sourceName = options.sourceUrl ? "remote-media" : job.source_name;
  const outputName = safeOutputName(options.outputFilename, `${stem(sourceName)}_audio.${format}`);
  const outputPath = path.join(jobDir, outputName);
  const durationMs = await mediaDuration(ffprobe, sourcePath, job.id);
  const codecArgs = format === "mp3"
    ? ["-c:a", "libmp3lame", "-b:a", bitrate]
    : format === "wav"
      ? ["-c:a", "pcm_s16le"]
      : format === "flac"
        ? ["-c:a", "flac"]
        : ["-c:a", "aac", "-b:a", bitrate];
  const containerArgs = format === "m4a" ? ["-movflags", "+faststart"] : [];
  update(job.id, 10, "Inspecting audio", "Checking the first audio track and duration.");
  update(job.id, 22, "Extracting audio", `Creating a ${format.toUpperCase()} audio file.`);
  const result = await runTrackedFfmpeg(ffmpeg, ["-y", "-hide_banner", "-v", "error", "-i", sourcePath, "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "0", ...codecArgs, ...containerArgs, outputPath], job.id, "Audio extraction", durationMs);
  logAttemptFailure(job.id, "Audio extraction", result);
  if (result.code !== 0 || !fs.existsSync(outputPath)) throw new Error(`Audio extraction could not create the selected output. ${commandFailure(result)}`);
  const outputBytes = await bytes(outputPath);
  const output = { path: outputPath, filename: outputName, bytes: outputBytes, inputBytes: await bytes(sourcePath), durationMs, format, method: `FFmpeg ${format.toUpperCase()} audio extraction` };
  appendJobLog(job.id, `Created ${outputName} successfully.`, "complete");
  updateJob(job.id, { status: "completed", progress: 100, stage: "Complete", message: "The extracted audio is ready to download.", warnings: [], result: output });
}

function safeOutputName(value, fallback) {
  const candidate = String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return candidate || fallback;
}

async function processPdfToImages(job) {
  const options = JSON.parse(job.options_json || "{}");
  const jobDir = path.dirname(job.source_path);
  const outputName = safeOutputName(options.outputFilename, `${stem(job.source_name)}_images.zip`);
  const outputPath = path.join(jobDir, outputName);
  update(job.id, 5, "Reading PDF", "Opening the PDF without changing the source file.");
  let archive;
  try {
    archive = await renderPdfToImageArchive(await fsp.readFile(job.source_path), {
      format: options.pdfFormat || "png",
      scale: options.pdfScale || 1.5,
      quality: options.pdfQuality || 90,
      onProgress: (progress, message) => update(job.id, Math.max(5, Math.min(99, progress)), "Rendering PDF pages", message),
    });
  } catch (error) {
    if (error?.name === "PasswordException") throw new Error("Password-protected PDFs must be unlocked before using PDF to images.");
    throw error;
  }
  await fsp.writeFile(outputPath, archive.bytes, { flag: "wx" });
  const output = { path: outputPath, filename: outputName, bytes: archive.bytes.length, inputBytes: await bytes(job.source_path), pageCount: archive.pageCount, format: archive.format, scale: archive.scale, quality: archive.quality, method: "PDF.js page rendering" };
  appendJobLog(job.id, `Created ${outputName} with ${archive.pageCount} page images.`, "complete");
  updateJob(job.id, { status: "completed", progress: 100, stage: "Complete", message: "The PDF page images are ready in a ZIP archive.", warnings: [], result: output });
}

async function processJob(job) {
  appendJobLog(job.id, `Worker started ${job.tool === "image-converter" ? "image conversion" : job.tool === "svg-to-png" ? "SVG to PNG conversion" : job.tool === "pdf-editor" ? "PDF editing" : job.tool === "pdf-text-editor" ? "PDF text editing" : job.tool === "pdf-compressor" ? "PDF compression" : job.tool === "video-compressor" ? "video compression" : job.tool === "audio-extractor" ? "audio extraction" : job.tool === "pdf-to-images" ? "PDF to images" : "video repair"}.`, "info");
  try {
    if (job.tool === "image-converter") await processImage(job);
    else if (job.tool === "svg-to-png") await processSvgToPng(job);
    else if (job.tool === "pdf-editor") await processPdfEditor(job);
    else if (job.tool === "pdf-text-editor") await processPdfTextEditor(job);
    else if (job.tool === "pdf-compressor") await processPdfCompressor(job);
    else if (job.tool === "video-repair") await processVideo(job);
    else if (job.tool === "video-compressor") await processVideoCompressor(job);
    else if (job.tool === "audio-extractor") await processAudioExtractor(job);
    else if (job.tool === "pdf-to-images") await processPdfToImages(job);
    else throw new Error("Unknown tool.");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Processing failed.";
    if (getJob(job.id)?.status === "cancelled") {
      await fsp.rm(path.dirname(job.source_path), { recursive: true, force: true }).catch(() => undefined);
      deleteJob(job.id);
      return;
    }
    appendJobLog(job.id, detail, "error");
    updateJob(job.id, {
      status: "failed",
      progress: 100,
      stage: shutdownRequested ? "Interrupted" : "Failed",
      message: shutdownRequested ? "Processing stopped because the worker restarted. Retry the job to continue." : "Processing failed.",
      error: shutdownRequested ? "The worker restarted before processing finished." : detail,
    });
  }
}

async function writeCapabilities() {
  const imageTool = await firstAvailable(["magick", "convert"]);
  const identify = await firstAvailable(["identify"]);
  const sips = await commandExists("sips");
  const ghostscript = await usableGhostscript();
  const heifTool = await firstAvailable(["heif-convert", "heif-enc"]);
  let imageMagickHeic = false;
  if (identify) {
    const result = await runCommand(identify, ["-list", "format"], { timeoutMs: 5000 });
    imageMagickHeic = result.code === 0 && /HEIC|HEIF/i.test(result.stdout);
  }
  // macOS sips is a supported HEIC path even when the ImageMagick build does
  // not expose a HEIC coder. Keep the lower-level libheif flag separate so the
  // UI can explain which implementation is actually available.
  const sharp = await loadSharp();
  const sharpHeic = Boolean(sharp?.format?.heif?.input);
  const heic = imageMagickHeic || sips || sharpHeic;
  const libheif = imageMagickHeic || Boolean(heifTool) || sharpHeic;
  const ffmpeg = await commandExists("ffmpeg");
  const ffprobe = await commandExists("ffprobe");
  const publicMediaDownloader = await commandExists("yt-dlp");
  const mkvmerge = await commandExists("mkvmerge");
  const values = {
    status: "ready",
    checkedAt: new Date().toISOString(),
    pdf: {
      textEditing: true,
      ocr: true,
      ocrLanguages: ["eng"],
      compressor: Boolean(ghostscript || sharp),
      compressorEngine: ghostscript ? "Ghostscript + bundled image recompression" : sharp ? "Bundled image recompression" : "PDF structural optimization",
      toImages: true,
    },
    image: { imagemagick: Boolean(imageTool), sharp: Boolean(sharp), sips, heic: heic || sips, libheif, formats: ["jpeg", "png", "heic", "tiff", "gif", "bmp"] },
    video: { ffmpeg, ffprobe, publicMediaDownloader, mkvmerge, mkvFallback: ffmpeg, untrunc: Boolean(await firstAvailable(untruncCandidates)), defaultReference: fs.existsSync(config.untruncReferencePath), compressor: Boolean(ffmpeg && ffprobe), audioExtractor: Boolean(ffmpeg && ffprobe), mediaUrl: Boolean(ffmpeg && ffprobe && publicMediaDownloader) },
  };
  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.writeFile(paths.capabilities, JSON.stringify(values, null, 2));
}

async function cleanupExpired() {
  const cutoff = Date.now() - config.jobRetentionHours * 60 * 60 * 1000;
  for (const row of listExpiredJobs(cutoff)) {
    const job = getJob(row.id);
    if (job) await fsp.rm(path.dirname(job.source_path), { recursive: true, force: true });
    deleteJob(row.id);
  }
  await fsp.mkdir(paths.pdfPreviews, { recursive: true });
  for (const entry of await fsp.readdir(paths.pdfPreviews, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(paths.pdfPreviews, entry.name);
    const stat = await fsp.stat(directory).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fsp.rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  process.once("SIGTERM", () => { shutdownRequested = true; });
  process.once("SIGINT", () => { shutdownRequested = true; });
  const releaseWorkerLock = acquireWorkerLock();
  try {
  await fsp.mkdir(paths.jobs, { recursive: true });
  const interrupted = failInterruptedJobs();
  if (interrupted) console.log(`Marked ${interrupted} interrupted job(s) for retry.`);
  await writeCapabilities();
  console.log("NativeMedia Agent worker is ready.");
  while (!shutdownRequested) {
    const job = claimNextJob();
    if (job) {
      console.log(`Processing ${job.id} (${job.tool})`);
      await processJob(job);
      continue;
    }
    await cleanupExpired();
    await sleep(1000);
  }
  console.log("NativeMedia Agent worker stopped.");
  } finally {
    releaseWorkerLock();
  }
}

export { acquireWorkerLock, processImage, processPdfEditor, processPdfCompressor, processPdfTextEditor, processVideo, processVideoCompressor, processAudioExtractor, processPdfToImages, processJob, writeCapabilities };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
