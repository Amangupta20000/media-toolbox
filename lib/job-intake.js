import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import Busboy from "busboy";
import { randomUUID } from "node:crypto";
import { config as appConfig, paths, supportedImageFormats } from "./config.js";
import { createJob, deleteJob } from "./db.js";
import { MAX_PDF_COUNT } from "./pdf-limits.js";
import { normalizeImageRotation } from "./pdf-image-placement.js";
import { PDF_TEXT_BOX_FONTS } from "./pdf-text-box.js";

export function safeFilename(name) {
  const basename = path.basename(name || "upload");
  return basename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "upload";
}

function safeFieldName(name) {
  return String(name || "file").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "file";
}

export function extension(name) {
  return path.extname(name).toLowerCase();
}

export function likelyFileForTool(file, tool) {
  const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".gif", ".bmp"]);
  const videoExtensions = new Set([".mp4", ".m4v", ".mov", ".3gp", ".mkv", ".webm", ".avi", ".mpeg", ".mpg"]);
  const pdfExtensions = new Set([".pdf"]);
  const allowed = tool === "image-converter" ? imageExtensions : tool === "video-repair" ? videoExtensions : pdfExtensions;
  const mime = String(file.mime || "");
  const mimePrefix = tool === "image-converter" ? "image/" : tool === "video-repair" ? "video/" : "application/pdf";
  return allowed.has(extension(file.name)) || mime.startsWith(mimePrefix);
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
  const fontSize = Number(textBox.fontSize ?? 18);
  const fontFamily = String(textBox.fontFamily || "Helvetica");
  const color = String(textBox.color || "#173b53");
  const backgroundColor = String(textBox.backgroundColor || "transparent");
  if (text.length > 20000 || ![x, y, fontSize].every(Number.isFinite) || fontSize < 1 || fontSize > 500 || x < -maxPdfImageCoordinate || y < -maxPdfImageCoordinate || x + width > maxPdfImageCoordinate || y + height > maxPdfImageCoordinate) throw new Error(`Text box ${textBoxIndex + 1} on page ${pageIndex + 1} has invalid text or placement.`);
  if (!PDF_TEXT_BOX_FONTS.some((font) => font.value === fontFamily)) throw new Error(`Text box ${textBoxIndex + 1} on page ${pageIndex + 1} uses an unsupported font.`);
  if (!/^#[0-9a-f]{6}$/i.test(color) || (backgroundColor !== "transparent" && !/^#[0-9a-f]{6}$/i.test(backgroundColor))) throw new Error(`Text box ${textBoxIndex + 1} on page ${pageIndex + 1} has an invalid colour.`);
  return { id: String(textBox.id || `text-box-${pageIndex + 1}-${textBoxIndex + 1}`), text, x, y, width, height, fontSize, fontFamily, bold: Boolean(textBox.bold), italic: Boolean(textBox.italic), underline: Boolean(textBox.underline), color: color.toLowerCase(), backgroundColor: backgroundColor === "transparent" ? "transparent" : backgroundColor.toLowerCase() };
}

function parseTextBoxes(operation, pageIndex) {
  if (operation.textBoxes === undefined) return [];
  if (!Array.isArray(operation.textBoxes) || operation.textBoxes.length > 100) throw new Error(`Page ${pageIndex + 1} has too many text boxes.`);
  return operation.textBoxes.map((textBox, textBoxIndex) => validateTextBox(textBox, pageIndex, textBoxIndex));
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
  }));
  createJob({ id, tool: "pdf-editor", sourcePath: manifestPath, sourceName: "PDF editor project", options: { pdfCount: pdfFiles.length, pageCount: pages.length, retention: fields.retention === "keep" ? "keep" : "delete" } });
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
    const rotation = Number(edit?.rotation ?? 0);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || !runId || !/^[a-f0-9]{64}$/i.test(originalTextHash)) throw new Error("Each PDF text edit must include a valid page, run, and original text hash.");
    if (originalText.length > 10000) throw new Error("PDF text identities must be no longer than 10,000 characters.");
    if (replacementText.includes("\n") || replacementText.includes("\r") || replacementText.length > 10000) throw new Error("PDF replacements must be one line and no longer than 10,000 characters.");
    if (![offsetX, offsetY].every(Number.isFinite) || Math.abs(offsetX) > 100000 || Math.abs(offsetY) > 100000) throw new Error("Text movement must be a finite page offset within the PDF page.");
    if (!Number.isFinite(scale) || scale < 0.25 || scale > 4 || !Number.isFinite(rotation) || Math.abs(rotation) > 100000) throw new Error("Text size and rotation must be within the supported range.");
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
      return { pageIndex, runId, originalTextHash, originalText, replacementText, mode, offsetX, offsetY, scale, rotation, bbox: { x0: values[0], y0: values[1], x1: values[2], y1: values[3] }, confidence: Number(edit?.confidence) || 0 };
    }
    return { pageIndex, runId, originalTextHash, originalText, ...(moveOnly ? { moveOnly: true } : { replacementText }), mode, offsetX, offsetY, scale, rotation, ...(operatorOrdinals ? { operatorOrdinals } : {}), ...(operatorGroups ? { operatorGroups } : {}) };
  });
}

async function createPdfTextEditorJob({ id, fields, files }) {
  const sources = files.filter((file) => file.field === "source");
  if (sources.length !== 1) throw new Error("Add exactly one PDF.");
  const source = sources[0];
  if (!likelyFileForTool(source, "pdf-text-editor")) throw new Error(`${source.name} is not a PDF.`);
  if (source.size > appConfig.pdfMaxBytes) throw new Error(`${source.name} is larger than the 200 MB PDF limit.`);
  const edits = parsePdfTextEdits(fields.edits);
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
      retention: fields.retention === "keep" ? "keep" : "delete",
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

export async function createJobFromMultipart({ id = randomUUID(), jobDir, fields, files }) {
  const tool = fields.tool;
  if (!["image-converter", "video-repair", "pdf-editor", "pdf-text-editor"].includes(tool)) throw new Error("Choose a supported tool.");
  if (tool === "pdf-editor") {
    return { ...(await createPdfEditorJob({ id, jobDir, fields, files })), tool };
  }
  if (tool === "pdf-text-editor") {
    return { ...(await createPdfTextEditorJob({ id, fields, files })), tool };
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
  } else {
    if (source.size > appConfig.videoMaxBytes) throw new Error(`Videos must be smaller than ${Math.round(appConfig.videoMaxBytes / 1024 / 1024 / 1024)} GB.`);
    createJob({ id, tool, sourcePath: source.path, sourceName: source.name, referencePath: reference?.path, referenceName: reference?.name, options: { hasReference: Boolean(reference), retention: fields.retention === "keep" ? "keep" : "delete" } });
    return { ids: [id], tool };
  }
}

export async function acceptMultipartJob(request, { id = randomUUID(), jobDir }) {
  const { fields, files } = await parseMultipart(request, jobDir);
  return createJobFromMultipart({ id, jobDir, fields, files });
}

export { appConfig, paths };
