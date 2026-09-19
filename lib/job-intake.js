import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import Busboy from "busboy";
import { randomUUID } from "node:crypto";
import { config as appConfig, paths, supportedImageFormats } from "./config.js";
import { createJob, deleteJob, getJob } from "./db.js";
import { MAX_PDF_COUNT } from "./pdf-limits.js";
import { normalizeImageRotation } from "./pdf-image-placement.js";
import { PDF_TEXT_BOX_FONTS } from "./pdf-text-box.js";
import { normalizeTextFormat } from "./pdf-text-format.js";
import { normalizeSvgOptions, validateSvgMarkup } from "./svg-options.js";

export function safeFilename(name) {
  const basename = path.basename(name || "upload");
  return basename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "upload";
}

export function safePdfOutputFilename(name, fallback = "edited.pdf") {
  const fallbackStem = safeFilename(fallback).replace(/\.pdf$/i, "").replace(/^\.+$/, "") || "edited";
  const candidateStem = String(name || "").trim()
    ? safeFilename(name).replace(/\.pdf$/i, "").replace(/^\.+$/, "").slice(0, 176).trim()
    : "";
  return `${candidateStem || fallbackStem}.pdf`;
}

function normalizeHistoryStatus(value) {
  return String(value || "").toLowerCase() === "saved" ? "saved" : "completed";
}

function safeFieldName(name) {
  return String(name || "file").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "file";
}

export function extension(name) {
  return path.extname(name).toLowerCase();
}

export function likelyFileForTool(file, tool) {
  const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".gif", ".bmp"]);
  const svgExtensions = new Set([".svg"]);
  const videoExtensions = new Set([".mp4", ".m4v", ".mov", ".3gp", ".mkv", ".webm", ".avi", ".mpeg", ".mpg"]);
  const pdfExtensions = new Set([".pdf"]);
  const videoTool = ["video-repair", "video-compressor", "audio-extractor"].includes(tool);
  const allowed = tool === "image-converter" ? imageExtensions : tool === "svg-to-png" ? svgExtensions : videoTool ? videoExtensions : pdfExtensions;
  const mime = String(file.mime || "");
  const mimePrefix = tool === "image-converter" ? "image/" : tool === "svg-to-png" ? "image/svg+xml" : videoTool ? "video/" : "application/pdf";
  return allowed.has(extension(file.name)) || mime === mimePrefix || (tool !== "svg-to-png" && mime.startsWith(mimePrefix));
}

export function parseMultipart(request, jobDir, { fileSize = Math.max(appConfig.videoMaxBytes, appConfig.pdfMaxBytes, appConfig.pdfImageMaxBytes) } = {}) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"];
    if (!contentType?.includes("multipart/form-data")) return reject(new Error("Expected a multipart upload."));
    const parser = Busboy({
      headers: { "content-type": contentType },
      limits: {
        files: 256,
        fields: 12,
        fileSize,
      },
    });
    const fields = {};
    const files = [];
    const pending = [];
    let fileOrder = 0;
    parser.on("field", (name, value) => { fields[name] = value; });
    parser.on("file", (field, file, info) => {
      const name = safeFilename(info.filename);
      const order = fileOrder;
      fileOrder += 1;
      const target = path.join(jobDir, `${safeFieldName(field)}-${order}-${name}`);
      const output = fs.createWriteStream(target, { flags: "wx" });
      let size = 0;
      let truncated = false;
      file.on("data", (chunk) => { size += chunk.length; });
      file.on("limit", () => { truncated = true; });
      const completion = new Promise((fileResolve, fileReject) => {
        file.on("error", fileReject);
        output.on("error", fileReject);
        output.on("finish", () => {
          if (truncated) return fileReject(new Error("The uploaded file exceeds the maximum size limit."));
          files.push({ field, name, mime: info.mimeType || "application/octet-stream", path: target, size, order });
          fileResolve();
        });
      });
      pending.push(completion);
      file.pipe(output);
    });
    parser.on("error", reject);
    parser.on("finish", async () => {
      try {
        await Promise.all(pending);
        files.sort((left, right) => left.order - right.order);
        resolve({ fields, files });
      } catch (error) {
        reject(error);
      }
    });
    request.pipe(parser);
  });
}

const pdfImageExtensions = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".gif", ".bmp"]);
const maxPdfImageCoordinate = 100000;

function parsePdfOperations(value) {
  let operations;
  try { operations = JSON.parse(value || ""); } catch { throw new Error("The PDF page arrangement could not be read."); }
  if (!Array.isArray(operations) || operations.length === 0) throw new Error("Add at least one PDF page before exporting.");
  if (operations.length > 2000) throw new Error("This PDF project has too many pages.");
  return operations;
}

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number.`);
  return number;
}

function validateImagePlacement(image, width, height) {
  if (!image) throw new Error("The blank page image details are missing.");
  const x = Number(image.x);
  const y = Number(image.y);
  const imageWidth = finitePositive(image.width, "Image width");
  const imageHeight = finitePositive(image.height, "Image height");
  const imageRotation = image.rotation === undefined ? 0 : Number(image.rotation);
  if (![x, y, imageRotation].every((value) => Number.isFinite(value)) || x < -maxPdfImageCoordinate || y < -maxPdfImageCoordinate || x + imageWidth > maxPdfImageCoordinate || y + imageHeight > maxPdfImageCoordinate) {
    throw new Error("The image placement or rotation is outside the supported PDF coordinate range.");
  }
  return { x, y, width: imageWidth, height: imageHeight, rotation: normalizeImageRotation(imageRotation) };
}

function validateTextBox(textBox, pageIndex, textBoxIndex) {
  if (!textBox || typeof textBox !== "object") throw new Error(`Text box ${textBoxIndex + 1} on page ${pageIndex + 1} is invalid.`);
  const text = String(textBox.text ?? "");
  const x = Number(textBox.x);
  const y = Number(textBox.y);
  const width = finitePositive(textBox.width, "Text box width");
  const height = finitePositive(textBox.height, "Text box height");
  const rotation = Number(textBox.rotation ?? 0);
  const fontSize = Number(textBox.fontSize ?? 18);
  const fontFamily = String(textBox.fontFamily || "Helvetica");
  const color = String(textBox.color || "#173b53");
  const backgroundColor = String(textBox.backgroundColor || "transparent");
  if (text.length > 20000 || ![x, y, rotation, fontSize].every(Number.isFinite) || Math.abs(rotation) > 100000 || fontSize < 1 || fontSize > 500 || x < -maxPdfImageCoordinate || y < -maxPdfImageCoordinate || x + width > maxPdfImageCoordinate || y + height > maxPdfImageCoordinate) throw new Error(`Text box ${textBoxIndex + 1} on page ${pageIndex + 1} has invalid text or placement.`);
  if (!PDF_TEXT_BOX_FONTS.some((font) => font.value === fontFamily)) throw new Error(`Text box ${textBoxIndex + 1} on page ${pageIndex + 1} uses an unsupported font.`);
  if (!/^#[0-9a-f]{6}$/i.test(color) || (backgroundColor !== "transparent" && !/^#[0-9a-f]{6}$/i.test(backgroundColor))) throw new Error(`Text box ${textBoxIndex + 1} on page ${pageIndex + 1} has an invalid colour.`);
  const runs = textBox.runs === undefined ? [] : textBox.runs;
  if (!Array.isArray(runs) || runs.length > 2000) throw new Error(`Text box ${textBoxIndex + 1} on page ${pageIndex + 1} has too many styled text ranges.`);
  let previousEnd = 0;
  const normalizedRuns = runs.map((run, runIndex) => {
    if (!run || typeof run !== "object") throw new Error(`Text box ${textBoxIndex + 1} styled range ${runIndex + 1} is invalid.`);
    const start = Number(run.start);
    const end = Number(run.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < previousEnd || end <= start || end > text.length) throw new Error(`Text box ${textBoxIndex + 1} styled range ${runIndex + 1} has invalid text bounds.`);
    const runFontFamily = String(run.fontFamily ?? fontFamily);
    const runFontSize = Number(run.fontSize ?? fontSize);
    const runColor = String(run.color ?? color);
    const runBackgroundColor = String(run.backgroundColor ?? backgroundColor);
    if (!PDF_TEXT_BOX_FONTS.some((font) => font.value === runFontFamily) || !Number.isFinite(runFontSize) || runFontSize < 1 || runFontSize > 500 || !/^#[0-9a-f]{6}$/i.test(runColor) || (runBackgroundColor !== "transparent" && !/^#[0-9a-f]{6}$/i.test(runBackgroundColor))) throw new Error(`Text box ${textBoxIndex + 1} styled range ${runIndex + 1} has invalid formatting.`);
    previousEnd = end;
    return { start, end, fontFamily: runFontFamily, fontSize: runFontSize, bold: Boolean(run.bold), italic: Boolean(run.italic), underline: Boolean(run.underline), color: runColor.toLowerCase(), backgroundColor: runBackgroundColor === "transparent" ? "transparent" : runBackgroundColor.toLowerCase() };
  });
  return { id: String(textBox.id || `text-box-${pageIndex + 1}-${textBoxIndex + 1}`), text, x, y, width, height, rotation, fontSize, fontFamily, bold: Boolean(textBox.bold), italic: Boolean(textBox.italic), underline: Boolean(textBox.underline), color: color.toLowerCase(), backgroundColor: backgroundColor === "transparent" ? "transparent" : backgroundColor.toLowerCase(), runs: normalizedRuns };
}

function parseTextBoxes(operation, pageIndex) {
  if (operation.textBoxes === undefined) return [];
  if (!Array.isArray(operation.textBoxes) || operation.textBoxes.length > 100) throw new Error(`Page ${pageIndex + 1} has too many text boxes.`);
  return operation.textBoxes.map((textBox, textBoxIndex) => validateTextBox(textBox, pageIndex, textBoxIndex));
}

function retainedReplacementJobId(value, tool) {
  const id = String(value || "").trim();
  if (!id) return "";
  if (!/^[a-f0-9-]{20,80}$/i.test(id)) throw new Error("The saved PDF replacement target is invalid.");
  const job = getJob(id);
  if (!job || job.tool !== tool || job.status !== "completed") throw new Error("The saved PDF replacement target is no longer available.");
  let options;
  try { options = JSON.parse(job.options_json || "{}"); } catch { options = {}; }
  if (options.retention !== "keep") throw new Error("The saved PDF replacement target is no longer retained.");
  let result;
  try { result = JSON.parse(job.result_json || "{}"); } catch { result = null; }
  if (!result?.path) throw new Error("The saved PDF replacement file is no longer available.");
  return id;
}

function parseImageAttachments(operation, imageByField, width, height, pageIndex) {
  const requestedImages = Array.isArray(operation.images) ? operation.images : operation.imageField ? [{ imageField: operation.imageField, image: operation.image }] : [];
  if (requestedImages.length > 50) throw new Error(`Page ${pageIndex + 1} has too many images.`);
  return requestedImages.map((imageOperation, imageIndex) => {
    const imageFile = imageByField.get(imageOperation?.imageField);
    const mime = String(imageFile?.mime || "");
    if (!imageFile || (!mime.startsWith("image/") && !pdfImageExtensions.has(extension(imageFile.name)))) throw new Error(`Image ${imageIndex + 1} on page ${pageIndex + 1} is not a supported image.`);
    if (imageFile.size > appConfig.pdfImageMaxBytes) throw new Error(`${imageFile.name} is larger than the 25 MB image limit.`);
    return { path: imageFile.path, name: imageFile.name, mime: imageFile.mime, placement: validateImagePlacement(imageOperation.image, width, height) };
  });
}

async function createPdfEditorJob({ id, jobDir, fields, files }) {
  const pdfFiles = files.filter((file) => file.field === "pdf");
  if (pdfFiles.length > MAX_PDF_COUNT) throw new Error(`You can add up to ${MAX_PDF_COUNT} PDFs at a time.`);
  for (const file of pdfFiles) {
    if (!likelyFileForTool(file, "pdf-editor")) throw new Error(`${file.name} is not a PDF.`);
    if (file.size > appConfig.pdfMaxBytes) throw new Error(`${file.name} is larger than the 200 MB PDF limit.`);
  }
  const totalPdfBytes = pdfFiles.reduce((total, file) => total + file.size, 0);
  if (totalPdfBytes > appConfig.pdfTotalMaxBytes) throw new Error("The combined PDF upload is larger than the 200 MB limit.");

  const imageFiles = files.filter((file) => file.field.startsWith("page-image-"));
  const imageByField = new Map(imageFiles.map((file) => [file.field, file]));
  const operations = parsePdfOperations(fields.operations);
  const fallbackOutputName = pdfFiles.length === 1
    ? `${safeFilename(pdfFiles[0].name).replace(/\.pdf$/i, "")}_edited.pdf`
    : pdfFiles.length > 1
      ? "merged_edited.pdf"
      : "blank_pages_edited.pdf";
  const outputFilename = safePdfOutputFilename(fields.filename, fallbackOutputName);
  const replaceJobId = retainedReplacementJobId(fields.replaceJobId, "pdf-editor");
  const pages = operations.map((operation, index) => {
    if (!operation || typeof operation !== "object") throw new Error(`Page ${index + 1} is invalid.`);
    if (operation.kind === "source") {
      const pdfIndex = Number(operation.pdfIndex);
      const pageIndex = Number(operation.pageIndex);
      if (!Number.isInteger(pdfIndex) || pdfIndex < 0 || pdfIndex >= pdfFiles.length || !Number.isInteger(pageIndex) || pageIndex < 0) throw new Error(`Page ${index + 1} points to an invalid PDF page.`);
      const page = { kind: "source", pdfIndex, pageIndex };
      if (operation.rotation !== undefined) {
        page.rotation = Number(operation.rotation || 0);
        if (![0, 90, 180, 270].includes(page.rotation)) throw new Error(`PDF page ${index + 1} has invalid rotation.`);
      }
      if (Array.isArray(operation.images) || operation.imageField || Array.isArray(operation.textBoxes)) {
        const width = finitePositive(operation.width, "PDF page width");
        const height = finitePositive(operation.height, "PDF page height");
        page.width = width;
        page.height = height;
        page.rotation = page.rotation ?? 0;
        page.images = parseImageAttachments(operation, imageByField, width, height, index);
        page.textBoxes = parseTextBoxes(operation, index);
      }
      return page;
    }
    if (operation.kind !== "blank") throw new Error(`Page ${index + 1} has an unsupported type.`);
    const width = finitePositive(operation.width, "Blank page width");
    const height = finitePositive(operation.height, "Blank page height");
    const rotation = Number(operation.rotation || 0);
    if (width > 2000 || height > 2000 || ![0, 90, 180, 270].includes(rotation)) throw new Error(`Blank page ${index + 1} has invalid dimensions or rotation.`);
    return { kind: "blank", width, height, rotation, images: parseImageAttachments(operation, imageByField, width, height, index), textBoxes: parseTextBoxes(operation, index) };
  });

  const manifestPath = path.join(jobDir, "manifest.json");
  await fsPromises.writeFile(manifestPath, JSON.stringify({
    pdfs: pdfFiles.map((file) => ({ path: file.path, name: file.name, size: file.size })),
    pages,
    outputFilename,
  }));
  createJob({ id, tool: "pdf-editor", sourcePath: manifestPath, sourceName: "PDF editor project", options: { pdfCount: pdfFiles.length, pageCount: pages.length, outputFilename, retention: fields.retention === "keep" ? "keep" : "delete", historyStatus: normalizeHistoryStatus(fields.historyStatus), ...(replaceJobId ? { replaceJobId } : {}) } });
  return { ids: [id] };
}

function parsePdfTextEdits(value) {
  let edits;
  try { edits = JSON.parse(value || ""); } catch { throw new Error("The PDF text edits could not be read."); }
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("Select and change at least one PDF text run before exporting.");
  if (edits.length > 500) throw new Error("This PDF has too many text edits for one export.");
  return edits.map((edit) => {
    const pageIndex = Number(edit?.pageIndex);
    const runId = String(edit?.runId || "");
    const originalTextHash = String(edit?.originalTextHash || "");
    const originalText = String(edit?.originalText ?? "");
    const replacementText = String(edit?.replacementText ?? "");
    const moveOnly = edit?.moveOnly === true;
    const mode = edit?.mode === "ocr" ? "ocr" : "native";
    const offsetX = Number(edit?.offsetX ?? 0);
    const offsetY = Number(edit?.offsetY ?? 0);
    const scale = Number(edit?.scale ?? 1);
    const scaleX = Number(edit?.scaleX ?? scale);
    const scaleY = Number(edit?.scaleY ?? scale);
    const rotation = Number(edit?.rotation ?? 0);
    const boxWidth = Number(edit?.boxWidth ?? 0);
    const format = edit?.format === undefined ? null : normalizeTextFormat(edit.format, { fontFamily: "Helvetica", fontSize: 18, color: "#000000" });
    if (edit?.format !== undefined && (!edit.format || typeof edit.format !== "object" || !format)) throw new Error("Each PDF text format must be a supported font, size, style, colour, alignment, and spacing configuration.");
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || !runId || !/^[a-f0-9]{64}$/i.test(originalTextHash)) throw new Error("Each PDF text edit must include a valid page, run, and original text hash.");
    if (originalText.length > 10000) throw new Error("PDF text identities must be no longer than 10,000 characters.");
    if (replacementText.includes("\n") || replacementText.includes("\r") || replacementText.length > 10000) throw new Error("PDF replacements must be one line and no longer than 10,000 characters.");
    if (![offsetX, offsetY].every(Number.isFinite) || Math.abs(offsetX) > 100000 || Math.abs(offsetY) > 100000) throw new Error("Text movement must be a finite page offset within the PDF page.");
    if (!Number.isFinite(boxWidth) || boxWidth < 0 || boxWidth > 100000) throw new Error("Text alignment width must be a finite PDF width within the supported range.");
    if (![scale, scaleX, scaleY].every((value) => Number.isFinite(value) && value >= 0.25 && value <= 4) || !Number.isFinite(rotation) || Math.abs(rotation) > 100000) throw new Error("Text size and rotation must be within the supported range.");
    const operatorOrdinals = edit?.operatorOrdinals === undefined ? undefined : Array.isArray(edit.operatorOrdinals) ? edit.operatorOrdinals.map(Number) : null;
    if (operatorOrdinals === null || (operatorOrdinals && (!operatorOrdinals.length || operatorOrdinals.length > 5000 || operatorOrdinals.some((value, index) => !Number.isInteger(value) || value < 0 || (index > 0 && value <= operatorOrdinals[index - 1]))))) throw new Error("Each grouped PDF text edit must include ordered text operators.");
    const operatorGroups = edit?.operatorGroups === undefined ? undefined : Array.isArray(edit.operatorGroups) ? edit.operatorGroups.map((group) => {
      const operatorOrdinal = Number(group?.operatorOrdinal);
      const ordinals = group?.operatorOrdinals === undefined ? [operatorOrdinal] : Array.isArray(group.operatorOrdinals) ? group.operatorOrdinals.map(Number) : null;
      if (!Number.isInteger(operatorOrdinal) || operatorOrdinal < 0 || !ordinals?.length || ordinals.length > 5000 || ordinals.some((value, index) => !Number.isInteger(value) || value < 0 || (index > 0 && value <= ordinals[index - 1])) || !ordinals.includes(operatorOrdinal)) throw new Error("Each duplicate PDF text group must include its selected operator.");
      return { operatorOrdinal, operatorOrdinals: ordinals };
    }) : null;
    if (operatorGroups === null || (operatorGroups && (!operatorGroups.length || operatorGroups.length > 5000 || operatorGroups.reduce((total, group) => total + group.operatorOrdinals.length, 0) > 5000))) throw new Error("Each duplicate PDF text edit must include ordered text groups.");
    if (mode === "ocr") {
      const bbox = edit?.bbox;
      const values = [bbox?.x0, bbox?.y0, bbox?.x1, bbox?.y1].map(Number);
      if (!originalText || !values.every(Number.isFinite) || values[0] < 0 || values[1] < 0 || values[2] <= values[0] || values[3] <= values[1] || values[2] > 100000 || values[3] > 100000) throw new Error("Each OCR edit must include its original text and a valid page region.");
      return { pageIndex, runId, originalTextHash, originalText, replacementText, mode, offsetX, offsetY, scale, scaleX, scaleY, rotation, ...(format ? { format } : {}), ...(boxWidth ? { boxWidth } : {}), bbox: { x0: values[0], y0: values[1], x1: values[2], y1: values[3] }, confidence: Number(edit?.confidence) || 0 };
    }
    return { pageIndex, runId, originalTextHash, originalText, ...(moveOnly && !format ? { moveOnly: true } : { replacementText }), mode, offsetX, offsetY, scale, scaleX, scaleY, rotation, ...(format ? { format } : {}), ...(boxWidth ? { boxWidth } : {}), ...(operatorOrdinals ? { operatorOrdinals } : {}), ...(operatorGroups ? { operatorGroups } : {}) };
  });
}

async function createPdfTextEditorJob({ id, fields, files }) {
  const sources = files.filter((file) => file.field === "source");
  if (sources.length !== 1) throw new Error("Add exactly one PDF.");
  const source = sources[0];
  if (!likelyFileForTool(source, "pdf-text-editor")) throw new Error(`${source.name} is not a PDF.`);
  if (source.size > appConfig.pdfMaxBytes) throw new Error(`${source.name} is larger than the 200 MB PDF limit.`);
  const edits = parsePdfTextEdits(fields.edits);
  const fallbackOutputName = `${safeFilename(source.name).replace(/\.pdf$/i, "")}_${edits.some((edit) => edit.mode === "ocr") ? "ocr_text" : "text"}_edited.pdf`;
  const outputFilename = safePdfOutputFilename(fields.filename, fallbackOutputName);
  const replaceJobId = retainedReplacementJobId(fields.replaceJobId, "pdf-text-editor");
  createJob({
    id,
    tool: "pdf-text-editor",
    sourcePath: source.path,
    sourceName: source.name,
    options: {
      edits,
      sourceHash: /^[a-f0-9]{64}$/i.test(String(fields.sourceHash || "")) ? String(fields.sourceHash).toLowerCase() : "",
      ocr: edits.some((edit) => edit.mode === "ocr"),
      passwordProvided: Boolean(fields.password),
      outputFilename,
      retention: fields.retention === "keep" ? "keep" : "delete",
      historyStatus: normalizeHistoryStatus(fields.historyStatus),
      ...(replaceJobId ? { replaceJobId } : {}),
    },
  });
  return { ids: [id] };
}

const pdfCompressionProfiles = new Set(["balanced", "small", "quality", "custom"]);

async function createPdfCompressorJob({ id, fields, files }) {
  const sources = files.filter((file) => file.field === "source");
  if (sources.length !== 1) throw new Error("Add exactly one PDF.");
  const source = sources[0];
  if (!likelyFileForTool(source, "pdf-compressor")) throw new Error(`${source.name} is not a PDF.`);
  if (source.size > appConfig.pdfMaxBytes) throw new Error(`${source.name} is larger than the 200 MB PDF limit.`);
  const compressionProfile = String(fields.compressionProfile || "balanced");
  if (!pdfCompressionProfiles.has(compressionProfile)) throw new Error("Choose a supported compression level.");
  const customQuality = fields.customQuality === undefined || fields.customQuality === "" ? 72 : Number(fields.customQuality);
  if (compressionProfile === "custom" && (!Number.isInteger(customQuality) || customQuality < 25 || customQuality > 90)) throw new Error("Choose a custom image quality between 25 and 90.");
  const customTargetMb = fields.customTargetMb === undefined || fields.customTargetMb === "" ? "" : Number(fields.customTargetMb);
  if (compressionProfile === "custom" && customTargetMb !== "" && (!Number.isFinite(customTargetMb) || customTargetMb < 1 || customTargetMb > 200)) throw new Error("Choose a custom target size between 1 and 200 MB.");
  const removeColor = ["1", "true", "on"].includes(String(fields.removeColor || "").toLowerCase());
  const fallbackOutputName = `${safeFilename(source.name).replace(/\.pdf$/i, "")}_compressed.pdf`;
  const outputFilename = safePdfOutputFilename(fields.filename, fallbackOutputName);
  createJob({
    id,
    tool: "pdf-compressor",
    sourcePath: source.path,
    sourceName: source.name,
    options: { compressionProfile, customQuality, customTargetMb, removeColor, outputFilename, retention: fields.retention === "keep" ? "keep" : "delete" },
  });
  return { ids: [id] };
}

const videoCompressionProfiles = new Set(["balanced", "small", "quality"]);
const audioFormats = new Set(["mp3", "wav", "aac", "flac", "m4a"]);
const audioBitrates = new Set(["128k", "192k", "256k"]);
const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

function isPrivateMediaHostname(value) {
  const hostname = String(value || "").replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return true;
  const version = isIP(hostname);
  if (version === 4) {
    const [first, second] = hostname.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127) || (first >= 224);
  }
  if (version === 6) {
    return hostname === "::1" || hostname === "::" || /^f[cd]/i.test(hostname) || /^fe[89ab]/i.test(hostname) || /^::ffff:(0:)?(10|127|169\.254|192\.168)\./i.test(hostname);
  }
  return false;
}

export function validateMediaSourceUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("Enter a valid media URL.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Only public HTTP(S) media URLs are supported.");
  }
  if (isPrivateMediaHostname(hostname)) {
    throw new Error("Local and private-network media URLs are not supported.");
  }
  if (parsed.port) {
    throw new Error("Only public HTTP(S) media URLs are supported.");
  }
  if (youtubeHosts.has(hostname) && /^\/playlist(?:\/|$)/i.test(parsed.pathname) && !parsed.searchParams.get("v")) {
    throw new Error("Enter one public media item URL, not a playlist or collection URL.");
  }
  // Keep a single YouTube video identity when a copied link contains playlist
  // or radio parameters. Other supported sites keep their original URL.
  if (youtubeHosts.has(hostname) && hostname === "youtu.be") {
    const videoId = parsed.pathname.split("/").filter(Boolean)[0];
    if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  }
  if (youtubeHosts.has(hostname)) {
    const videoId = parsed.searchParams.get("v");
    if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    return `https://www.youtube.com${parsed.pathname.replace(/\/+$/, "")}`;
  }
  parsed.hash = "";
  return parsed.toString();
}

// Compatibility alias for callers that used the first URL-input name.
export const validateAudioSourceUrl = validateMediaSourceUrl;

function safeMediaOutputFilename(value, fallback) {
  const candidate = String(value || "").trim();
  if (!candidate) return fallback;
  return safeFilename(candidate).replace(/\.[a-z0-9]{1,8}$/i, "") || fallback;
}

async function createVideoCompressorJob({ id, fields, files }) {
  const sources = files.filter((file) => file.field === "source");
  if (sources.length !== 1) throw new Error("Add exactly one video.");
  const source = sources[0];
  if (!likelyFileForTool(source, "video-compressor")) throw new Error(`${source.name} is not a supported video.`);
  if (source.size > appConfig.videoMaxBytes) throw new Error(`${source.name} is larger than ${Math.round(appConfig.videoMaxBytes / 1024 / 1024 / 1024)} GB.`);
  const profile = String(fields.compressionProfile || "balanced");
  if (!videoCompressionProfiles.has(profile)) throw new Error("Choose a supported video compression profile.");
  const fallbackOutputName = `${safeFilename(source.name).replace(/\.[a-z0-9]{1,8}$/i, "")}_compressed.mp4`;
  const requestedStem = safeMediaOutputFilename(fields.filename, "");
  const outputFilename = requestedStem ? `${requestedStem}.mp4` : fallbackOutputName;
  createJob({
    id,
    tool: "video-compressor",
    sourcePath: source.path,
    sourceName: source.name,
    options: {
      compressionProfile: profile,
      outputFilename,
      retention: fields.retention === "keep" ? "keep" : "delete",
      historyStatus: normalizeHistoryStatus(fields.historyStatus),
    },
  });
  return { ids: [id] };
}

async function createAudioExtractorJob({ id, jobDir, fields, files, allowRemoteMediaUrl = false }) {
  const sources = files.filter((file) => file.field === "source");
  const sourceUrl = String(fields.sourceUrl || "").trim();
  if (sources.length > 1 || (sources.length && sourceUrl)) throw new Error("Choose one video file or one URL, not both.");
  if (!sources.length && !sourceUrl) throw new Error("Add a video file or media URL.");
  if (sourceUrl && !allowRemoteMediaUrl) {
    const error = new Error("Media URL extraction is restricted to an authorized Admin session.");
    error.statusCode = 403;
    error.code = "admin_required_for_media_url";
    throw error;
  }
  const source = sources[0];
  if (source && !likelyFileForTool(source, "audio-extractor")) throw new Error(`${source.name} is not a supported video.`);
  if (source && source.size > appConfig.videoMaxBytes) throw new Error(`${source.name} is larger than ${Math.round(appConfig.videoMaxBytes / 1024 / 1024 / 1024)} GB.`);
  const validatedUrl = sourceUrl ? validateMediaSourceUrl(sourceUrl) : "";
  const format = String(fields.audioFormat || "mp3").toLowerCase();
  if (!audioFormats.has(format)) throw new Error("Choose a supported audio output format.");
  const bitrate = String(fields.audioBitrate || "192k").toLowerCase();
  if (!audioBitrates.has(bitrate)) throw new Error("Choose a supported audio bitrate.");
  const sourceName = source?.name || "remote-media";
  const fallbackOutputName = `${safeFilename(sourceName).replace(/\.[a-z0-9]{1,8}$/i, "")}_audio.${format}`;
  const requestedStem = safeMediaOutputFilename(fields.filename, "");
  const outputFilename = requestedStem ? `${requestedStem}.${format}` : fallbackOutputName;
  createJob({
    id,
    tool: "audio-extractor",
    sourcePath: source?.path || path.join(jobDir, "url-source"),
    sourceName,
    options: {
      audioFormat: format,
      audioBitrate: bitrate,
      outputFilename,
      ...(validatedUrl ? { sourceUrl: validatedUrl } : {}),
      retention: fields.retention === "keep" ? "keep" : "delete",
      historyStatus: normalizeHistoryStatus(fields.historyStatus),
    },
  });
  return { ids: [id] };
}

const pdfImageFormats = new Set(["png", "jpg"]);
const pdfImageScales = new Set(["1", "1.5", "2"]);

async function createPdfToImagesJob({ id, fields, files }) {
  const sources = files.filter((file) => file.field === "source");
  if (sources.length !== 1) throw new Error("Add exactly one PDF.");
  const source = sources[0];
  if (!likelyFileForTool(source, "pdf-to-images")) throw new Error(`${source.name} is not a PDF.`);
  if (source.size > appConfig.pdfMaxBytes) throw new Error(`${source.name} is larger than ${Math.round(appConfig.pdfMaxBytes / 1024 / 1024)} MB.`);
  const format = String(fields.pdfFormat || "png").toLowerCase();
  if (!pdfImageFormats.has(format)) throw new Error("Choose PNG or JPG output.");
  const scale = String(fields.pdfScale || "1.5");
  if (!pdfImageScales.has(scale)) throw new Error("Choose a supported PDF image scale.");
  const quality = fields.pdfQuality === undefined || fields.pdfQuality === "" ? 90 : Number(fields.pdfQuality);
  if (!Number.isInteger(quality) || quality < 50 || quality > 100) throw new Error("Choose a JPG quality between 50 and 100.");
  const fallbackOutputName = `${safeFilename(source.name).replace(/\.pdf$/i, "")}_images.zip`;
  const requestedStem = safeMediaOutputFilename(fields.filename, "");
  const outputFilename = requestedStem ? `${requestedStem}.zip` : fallbackOutputName;
  createJob({
    id,
    tool: "pdf-to-images",
    sourcePath: source.path,
    sourceName: source.name,
    options: {
      pdfFormat: format,
      pdfScale: Number(scale),
      pdfQuality: quality,
      outputFilename,
      retention: fields.retention === "keep" ? "keep" : "delete",
      historyStatus: normalizeHistoryStatus(fields.historyStatus),
    },
  });
  return { ids: [id] };
}

function parseImageOptions(value, count, fields) {
  if (!value) {
    return Array.from({ length: count }, () => ({
      format: fields.format || "original",
      method: fields.method || "auto",
      maxSizeKb: fields.maxSizeKb || "",
      jpegConfirmed: fields.jpegConfirmed === "true",
    }));
  }
  let options;
  try { options = JSON.parse(value); } catch { throw new Error("The image output settings could not be read."); }
  if (!Array.isArray(options) || options.length !== count) throw new Error("Choose output settings for every image.");
  return options.map((item) => ({
    format: item?.format || "original",
    method: item?.method || fields.method || "auto",
    maxSizeKb: item?.maxSizeKb ?? "",
    jpegConfirmed: item?.jpegConfirmed === true || item?.jpegConfirmed === "true",
  }));
}

function validateImageOptions(raw) {
  const format = raw.format || "original";
  if (!supportedImageFormats.some((item) => item.value === format)) throw new Error("Choose a supported output format.");
  const method = raw.method || "auto";
  if (!["auto", "imagemagick", "sips"].includes(method)) throw new Error("Choose a supported processing method.");
  const maxSizeKb = raw.maxSizeKb === "" || raw.maxSizeKb === undefined || raw.maxSizeKb === null ? undefined : Number(raw.maxSizeKb);
  if (maxSizeKb !== undefined && (!Number.isInteger(maxSizeKb) || maxSizeKb <= 0)) throw new Error("The size target must be a positive whole number of KB.");
  if (format === "jpeg" && !raw.jpegConfirmed) throw new Error("Confirm the JPEG transparency warning before continuing.");
  return { format, method, maxSizeKb, jpegConfirmed: Boolean(raw.jpegConfirmed) };
}

async function moveImageSource(source, jobDir, index) {
  const sourceDirectory = path.join(jobDir, `image-${index}`);
  await fsPromises.mkdir(sourceDirectory, { recursive: true });
  const targetPath = path.join(sourceDirectory, safeFilename(source.name));
  await fsPromises.rename(source.path, targetPath);
  return { ...source, path: targetPath };
}

export async function createJobFromMultipart({ id = randomUUID(), jobDir, fields, files, allowRemoteMediaUrl = false }) {
  const tool = fields.tool;
  if (!["image-converter", "svg-to-png", "video-repair", "video-compressor", "audio-extractor", "pdf-to-images", "pdf-editor", "pdf-text-editor", "pdf-compressor"].includes(tool)) throw new Error("Choose a supported tool.");
  if (tool === "pdf-editor") {
    return { ...(await createPdfEditorJob({ id, jobDir, fields, files })), tool };
  }
  if (tool === "pdf-text-editor") {
    return { ...(await createPdfTextEditorJob({ id, fields, files })), tool };
  }
  if (tool === "pdf-compressor") {
    return { ...(await createPdfCompressorJob({ id, fields, files })), tool };
  }
  if (tool === "video-compressor") {
    return { ...(await createVideoCompressorJob({ id, fields, files })), tool };
  }
  if (tool === "audio-extractor") {
    return { ...(await createAudioExtractorJob({ id, jobDir, fields, files, allowRemoteMediaUrl })), tool };
  }
  if (tool === "pdf-to-images") {
    return { ...(await createPdfToImagesJob({ id, fields, files })), tool };
  }
  const sources = files.filter((file) => file.field === "source");
  if (sources.length < 1) throw new Error("Select a source file first.");
  if (tool === "image-converter" && sources.length > 5) throw new Error("You can convert up to 5 images at a time.");
  if (tool !== "image-converter" && sources.length > 1) throw new Error("Select only one source file for this tool.");
  const source = sources[0];
  const reference = files.find((file) => file.field === "reference");
  if (sources.some((file) => !likelyFileForTool(file, tool))) throw new Error("One or more selected files do not match this tool.");
  if (reference && tool !== "video-repair") throw new Error("A reference file is only supported for video repair.");
  if (reference && !likelyFileForTool(reference, "video-repair")) throw new Error("The reference file must be a video.");

  if (tool === "image-converter") {
    for (const item of sources) {
      if (item.size > appConfig.imageMaxBytes) throw new Error(`${item.name} is larger than ${Math.round(appConfig.imageMaxBytes / 1024 / 1024)} MB.`);
    }
    const settings = parseImageOptions(fields.imageOptions, sources.length, fields).map(validateImageOptions);
    const ids = [];
    try {
      for (const [index, item] of sources.entries()) {
        const jobId = sources.length === 1 ? id : randomUUID();
        const movedSource = await moveImageSource(item, jobDir, index);
        createJob({ id: jobId, tool, sourcePath: movedSource.path, sourceName: movedSource.name, options: { ...settings[index], retention: fields.retention === "keep" ? "keep" : "delete" } });
        ids.push(jobId);
      }
    } catch (error) {
      for (const jobId of ids) deleteJob(jobId);
      throw error;
    }
    return { ids, tool };
  } else if (tool === "svg-to-png") {
    if (source.size > appConfig.imageMaxBytes) throw new Error(`SVG files must be smaller than ${Math.round(appConfig.imageMaxBytes / 1024 / 1024)} MB.`);
    const markup = await fsPromises.readFile(source.path, "utf8");
    validateSvgMarkup(markup);
    const svgOptions = normalizeSvgOptions(JSON.parse(fields.svgOptions || "{}"));
    createJob({ id, tool, sourcePath: source.path, sourceName: source.name.toLowerCase().endsWith(".svg") ? source.name : `${source.name}.svg`, options: { ...svgOptions, retention: fields.retention === "keep" ? "keep" : "delete" } });
    return { ids: [id], tool };
  } else {
    if (source.size > appConfig.videoMaxBytes) throw new Error(`Videos must be smaller than ${Math.round(appConfig.videoMaxBytes / 1024 / 1024 / 1024)} GB.`);
    createJob({ id, tool, sourcePath: source.path, sourceName: source.name, referencePath: reference?.path, referenceName: reference?.name, options: { hasReference: Boolean(reference), retention: fields.retention === "keep" ? "keep" : "delete" } });
    return { ids: [id], tool };
  }
}

export async function acceptMultipartJob(request, { id = randomUUID(), jobDir, allowRemoteMediaUrl = false }) {
  const { fields, files } = await parseMultipart(request, jobDir);
  return createJobFromMultipart({ id, jobDir, fields, files, allowRemoteMediaUrl });
}

export { appConfig, paths };
