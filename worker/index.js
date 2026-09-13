import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PDFDocument, degrees, rgb } from "pdf-lib";
import * as fontkit from "fontkit";
import { config, paths, untruncCandidates } from "../lib/config.js";
import { appendJobLog, claimNextJob, deleteJob, getJob, listExpiredJobs, updateJob } from "../lib/db.js";
import { commandExists, firstAvailable, runCommand } from "../lib/command.js";
import { applyPdfTextEdits } from "../lib/pdf-text-editor.js";
import { applyPdfOcrEdits } from "../lib/pdf-ocr.js";
import { rotatedImageDrawPlacement } from "../lib/pdf-image-placement.js";
import { layoutPdfTextRuns, textBoxColor, textBoxDrawPlacement, textBoxFontDefinition, textBoxFontName, textBoxTextRuns } from "../lib/pdf-text-box.js";
import { safePdfOutputFilename } from "../lib/job-intake.js";

let sharpPromise;
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

async function mediaDuration(ffprobe, file) {
  const result = await runCommand(ffprobe, ["-v", "error", "-show_entries", "format=duration:stream=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
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

  const result = await runCommand(ffmpeg, ["-progress", "pipe:2", "-stats_period", "2", ...args], { onStderr: readProgress });
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
      if (textBox.backgroundColor !== "transparent") {
        const background = textBoxColor(textBox.backgroundColor, "#ffffff");
        outputPage.drawRectangle({ x: placement.x, y: placement.y, width: placement.width, height: placement.height, color: rgb(background.r, background.g, background.b), borderWidth: 0 });
      }
      if (!String(textBox.text ?? "")) continue;
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

  const settings = {
    balanced: { pdfSettings: "ebook", label: "Balanced compression" },
    small: { pdfSettings: "screen", label: "Smallest-file compression" },
    quality: { pdfSettings: "prepress", label: "Higher-quality compression" },
  }[options.compressionProfile || "balanced"];
  if (!settings) throw new Error("Choose a supported compression level.");
  const outputName = safePdfOutputFilename(options.outputFilename, `${stem(job.source_name)}_compressed.pdf`);
  const jobDir = path.dirname(job.source_path);
  const outputPath = path.join(jobDir, outputName);
  const workPath = path.join(jobDir, `${outputName}.working`);
  const warnings = [];
  let method = "";

  update(job.id, 10, "Inspecting PDF", `Opening ${inputDocument.getPageCount()} page${inputDocument.getPageCount() === 1 ? "" : "s"}.`);
  const ghostscript = await usableGhostscript();
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
      method = `Ghostscript ${settings.label.toLowerCase()}`;
    } else {
      appendJobLog(job.id, `Ghostscript compression failed: ${commandFailure(compressed)}`, "warning");
      warnings.push("The PDF optimizer could not complete on this worker; a safe structural rewrite was used instead.");
    }
  } else {
    warnings.push("Ghostscript is not available or healthy on this worker; a safe structural rewrite was used instead.");
  }

  if (!method) {
    update(job.id, 48, "Optimizing PDF structure", "Rewriting the PDF with compressed object streams.");
    const rewritten = await inputDocument.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
    await fsp.writeFile(workPath, rewritten);
    method = "PDF structural optimization";
  }

  update(job.id, 82, "Validating PDF", "Checking that every page remains readable.");
  let outputBytes = await fsp.readFile(workPath);
  try {
    const validation = await PDFDocument.load(outputBytes, { updateMetadata: false, throwOnInvalidObject: false });
    if (validation.getPageCount() !== inputDocument.getPageCount()) throw new Error("The compressed PDF page count changed.");
  } catch {
    await fsp.rm(workPath, { force: true });
    throw new Error("The compressed PDF could not be validated.");
  }

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
  const outputName = `${stem(job.source_name)}_${isOcr ? "ocr_text" : "text"}_edited.pdf`;
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
  const durationMs = await mediaDuration(ffprobe, source);
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
  const sourceDurationMs = await mediaDuration(ffprobe, job.source_path);

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

async function processJob(job) {
  appendJobLog(job.id, `Worker started ${job.tool === "image-converter" ? "image conversion" : job.tool === "pdf-editor" ? "PDF editing" : job.tool === "pdf-text-editor" ? "PDF text editing" : job.tool === "pdf-compressor" ? "PDF compression" : "video repair"}.`, "info");
  try {
    if (job.tool === "image-converter") await processImage(job);
    else if (job.tool === "pdf-editor") await processPdfEditor(job);
    else if (job.tool === "pdf-text-editor") await processPdfTextEditor(job);
    else if (job.tool === "pdf-compressor") await processPdfCompressor(job);
    else if (job.tool === "video-repair") await processVideo(job);
    else throw new Error("Unknown tool.");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Processing failed.";
    appendJobLog(job.id, detail, "error");
    updateJob(job.id, { status: "failed", progress: 100, stage: "Failed", message: "Processing failed.", error: detail });
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
  const mkvmerge = await commandExists("mkvmerge");
  const values = {
    status: "ready",
    checkedAt: new Date().toISOString(),
    pdf: { textEditing: true, ocr: true, ocrLanguages: ["eng"], compressor: Boolean(ghostscript), compressorEngine: ghostscript ? "Ghostscript" : "PDF structural optimization" },
    image: { imagemagick: Boolean(imageTool), sharp: Boolean(sharp), sips, heic: heic || sips, libheif, formats: ["jpeg", "png", "heic", "tiff", "gif", "bmp"] },
    video: { ffmpeg, ffprobe: await commandExists("ffprobe"), mkvmerge, mkvFallback: ffmpeg, untrunc: Boolean(await firstAvailable(untruncCandidates)), defaultReference: fs.existsSync(config.untruncReferencePath) },
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
  await fsp.mkdir(paths.jobs, { recursive: true });
  await writeCapabilities();
  console.log("Media Toolbox worker is ready.");
  while (true) {
    const job = claimNextJob();
    if (job) {
      console.log(`Processing ${job.id} (${job.tool})`);
      await processJob(job);
      continue;
    }
    await cleanupExpired();
    await sleep(1000);
  }
}

export { processImage, processPdfEditor, processPdfCompressor, processPdfTextEditor, processVideo, processJob, writeCapabilities };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
