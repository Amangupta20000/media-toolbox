import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import Busboy from "busboy";
import { randomUUID } from "node:crypto";
import { config as appConfig, paths, supportedImageFormats } from "./config.js";
import { createJob } from "./db.js";

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

export function parseMultipart(request, jobDir) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"];
    if (!contentType?.includes("multipart/form-data")) return reject(new Error("Expected a multipart upload."));
    const parser = Busboy({
      headers: { "content-type": contentType },
      limits: {
        files: 256,
        fields: 12,
        fileSize: Math.max(appConfig.videoMaxBytes, appConfig.pdfMaxBytes, appConfig.pdfImageMaxBytes),
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
  if (![x, y].every((value) => Number.isFinite(value)) || x < 0 || y < 0 || x + imageWidth > width + 0.01 || y + imageHeight > height + 0.01) {
    throw new Error("The image must stay inside its PDF page.");
  }
  return { x, y, width: imageWidth, height: imageHeight };
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
  if (pdfFiles.length < 1) throw new Error("Add at least one PDF.");
  if (pdfFiles.length > 5) throw new Error("You can add up to 5 PDFs at a time.");
  for (const file of pdfFiles) {
    if (!likelyFileForTool(file, "pdf-editor")) throw new Error(`${file.name} is not a PDF.`);
    if (file.size > appConfig.pdfMaxBytes) throw new Error(`${file.name} is larger than the 50 MB PDF limit.`);
  }
  const totalPdfBytes = pdfFiles.reduce((total, file) => total + file.size, 0);
  if (totalPdfBytes > appConfig.pdfTotalMaxBytes) throw new Error("The combined PDF upload is larger than the 250 MB limit.");

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
      if (Array.isArray(operation.images) || operation.imageField) {
        const width = finitePositive(operation.width, "PDF page width");
        const height = finitePositive(operation.height, "PDF page height");
        page.width = width;
        page.height = height;
        page.rotation = Number(operation.rotation || 0);
        if (![0, 90, 180, 270].includes(page.rotation)) throw new Error(`PDF page ${index + 1} has invalid rotation.`);
        page.images = parseImageAttachments(operation, imageByField, width, height, index);
      }
      return page;
    }
    if (operation.kind !== "blank") throw new Error(`Page ${index + 1} has an unsupported type.`);
    const width = finitePositive(operation.width, "Blank page width");
    const height = finitePositive(operation.height, "Blank page height");
    const rotation = Number(operation.rotation || 0);
    if (width > 2000 || height > 2000 || ![0, 90, 180, 270].includes(rotation)) throw new Error(`Blank page ${index + 1} has invalid dimensions or rotation.`);
    return { kind: "blank", width, height, rotation, images: parseImageAttachments(operation, imageByField, width, height, index) };
  });

  const manifestPath = path.join(jobDir, "manifest.json");
  await fsPromises.writeFile(manifestPath, JSON.stringify({
    pdfs: pdfFiles.map((file) => ({ path: file.path, name: file.name, size: file.size })),
    pages,
  }));
  createJob({ id, tool: "pdf-editor", sourcePath: manifestPath, sourceName: "PDF editor project", options: { pdfCount: pdfFiles.length, pageCount: pages.length, retention: fields.retention === "keep" ? "keep" : "delete" } });
}

export async function createJobFromMultipart({ id = randomUUID(), jobDir, fields, files }) {
  const tool = fields.tool;
  if (!["image-converter", "video-repair", "pdf-editor"].includes(tool)) throw new Error("Choose a supported tool.");
  if (tool === "pdf-editor") {
    await createPdfEditorJob({ id, jobDir, fields, files });
    return { id, tool };
  }
  const source = files.find((file) => file.field === "source");
  const reference = files.find((file) => file.field === "reference");
  if (!source) throw new Error("Select a source file first.");
  if (!likelyFileForTool(source, tool)) throw new Error("The selected file type does not match this tool.");
  if (reference && tool !== "video-repair") throw new Error("A reference file is only supported for video repair.");
  if (reference && !likelyFileForTool(reference, "video-repair")) throw new Error("The reference file must be a video.");

  if (tool === "image-converter") {
    if (source.size > appConfig.imageMaxBytes) throw new Error(`Images must be smaller than ${Math.round(appConfig.imageMaxBytes / 1024 / 1024)} MB.`);
    const format = fields.format || "original";
    if (!supportedImageFormats.some((item) => item.value === format)) throw new Error("Choose a supported output format.");
    const method = fields.method || "auto";
    if (!["auto", "imagemagick", "sips"].includes(method)) throw new Error("Choose a supported processing method.");
    const maxSizeKb = fields.maxSizeKb ? Number(fields.maxSizeKb) : undefined;
    if (maxSizeKb !== undefined && (!Number.isInteger(maxSizeKb) || maxSizeKb <= 0)) throw new Error("The size target must be a positive whole number of KB.");
    if (format === "jpeg" && fields.jpegConfirmed !== "true") throw new Error("Confirm the JPEG transparency warning before continuing.");
    createJob({ id, tool, sourcePath: source.path, sourceName: source.name, options: { format, method, maxSizeKb, jpegConfirmed: fields.jpegConfirmed === "true", retention: fields.retention === "keep" ? "keep" : "delete" } });
  } else {
    if (source.size > appConfig.videoMaxBytes) throw new Error(`Videos must be smaller than ${Math.round(appConfig.videoMaxBytes / 1024 / 1024 / 1024)} GB.`);
    createJob({ id, tool, sourcePath: source.path, sourceName: source.name, referencePath: reference?.path, referenceName: reference?.name, options: { hasReference: Boolean(reference), retention: fields.retention === "keep" ? "keep" : "delete" } });
  }
  return { id, tool };
}

export async function acceptMultipartJob(request, { id = randomUUID(), jobDir }) {
  const { fields, files } = await parseMultipart(request, jobDir);
  return createJobFromMultipart({ id, jobDir, fields, files });
}

export { appConfig, paths };
