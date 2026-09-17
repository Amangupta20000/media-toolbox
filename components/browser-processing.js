import { normalizeSvgMarkup, normalizeSvgOptions } from "../lib/svg-options.js";

export const BROWSER_PDF_MAX_BYTES = 10 * 1024 * 1024;
export const BROWSER_PDF_EDITOR_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const BROWSER_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const BROWSER_PDF_EDITOR_IMAGE_MAX_BYTES = 1 * 1024 * 1024;
export const BROWSER_PDF_TEXT_EDITOR_MAX_BYTES = 25 * 1024 * 1024;
export const BROWSER_PDF_TEXT_EDITOR_MAX_PAGES = 100;
export const BROWSER_IMAGE_TARGET_TOLERANCE_BYTES = 10 * 1000;
export const BROWSER_SUPPORTED_TOOLS = new Set(["image-converter", "svg-to-png", "pdf-compressor", "pdf-editor", "pdf-text-editor"]);

const BROWSER_OUTPUT_MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
};

const BROWSER_OUTPUT_LABELS = {
  jpeg: "JPG",
  png: "PNG",
};

export function browserSupportsTool(tool) {
  return BROWSER_SUPPORTED_TOOLS.has(tool);
}

export function browserOutputMime(format) {
  return BROWSER_OUTPUT_MIME[format] || "";
}

export function browserOutputLabel(format) {
  return BROWSER_OUTPUT_LABELS[format] || String(format || "output").toUpperCase();
}

export function browserCapabilities(tool) {
  const supported = browserSupportsTool(tool) && typeof window !== "undefined" && typeof document !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof Image !== "undefined";
  const formats = supported ? detectBrowserOutputFormats() : { original: true, jpeg: false, png: false, heic: false, tiff: false, gif: false, bmp: false };
  return {
    available: supported,
    connected: supported,
    ready: supported,
    capabilities: {
      status: supported ? "ready" : "unavailable",
      browser: true,
      image: { browser: supported, formats },
      pdf: { browser: supported && ["pdf-compressor", "pdf-editor", "pdf-text-editor"].includes(tool) },
    },
    error: supported ? "" : "This browser does not support the required local conversion features.",
  };
}

export function browserSupportsFormat(format, capabilities = undefined) {
  if (format === "original") return true;
  const formats = capabilities || (typeof document !== "undefined" ? detectBrowserOutputFormats() : {});
  return Boolean(formats[format]);
}

function detectBrowserOutputFormats() {
  if (typeof document === "undefined") return { original: true, jpeg: false, png: false, heic: false, tiff: false, gif: false, bmp: false };
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const formats = { original: true };
  for (const [format, mime] of Object.entries(BROWSER_OUTPUT_MIME)) {
    try {
      formats[format] = canvas.toDataURL(mime).startsWith(`data:${mime}`);
    } catch {
      formats[format] = false;
    }
  }
  for (const format of ["heic", "tiff", "gif", "bmp"]) formats[format] = false;
  return formats;
}

function imageExtension(filename) {
  const match = String(filename || "").match(/\.([a-z0-9]{1,8})$/i);
  return match ? match[1].toLowerCase() : "png";
}

function safeStem(filename) {
  return String(filename || "image")
    .replace(/\.[a-z0-9]{1,8}$/i, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "image";
}

function outputExtension(format, sourceName) {
  if (format === "jpeg") return "jpg";
  if (format === "original") return imageExtension(sourceName);
  return format;
}

function outputName(sourceName, format) {
  return `${safeStem(sourceName)}_converted.${outputExtension(format, sourceName)}`;
}

function browserProcessingError(error) {
  if (error?.name === "QuotaExceededError" || error?.name === "InvalidStateError" || /memory|allocation|too large/i.test(error?.message || "")) {
    return new Error("This file is too large for this browser to process. Use the Local agent on a desktop computer.");
  }
  return error instanceof Error ? error : new Error("The browser could not process this file.");
}

async function decodeImage(source) {
  const url = URL.createObjectURL(source);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    if (typeof image.decode === "function") {
      try {
        await image.decode();
      } catch {
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error("The browser could not decode this image."));
        });
      }
    } else {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("The browser could not decode this image."));
      });
    }
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("The browser could not read the image dimensions.");
    return { image, url, width: image.naturalWidth, height: image.naturalHeight };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw browserProcessingError(error);
  }
}

function createCanvas(width, height) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("The browser could not create an image canvas.");
    return { canvas, context };
  } catch (error) {
    throw browserProcessingError(error);
  }
}

function hexRgb(color) {
  const value = String(color || "#ffffff").replace(/^#/, "");
  return {
    red: Number.parseInt(value.slice(0, 2), 16),
    green: Number.parseInt(value.slice(2, 4), 16),
    blue: Number.parseInt(value.slice(4, 6), 16),
  };
}

function rgbaColor(color, opacity = 100) {
  const { red, green, blue } = hexRgb(color);
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(100, Number(opacity))) / 100})`;
}

function gradientPoint(angle, distance) {
  const radians = (Number(angle || 0) - 90) * Math.PI / 180;
  return {
    x: 50 + Math.cos(radians) * distance,
    y: 50 + Math.sin(radians) * distance,
  };
}

function fillBackground(context, width, height, { background = "transparent", backgroundColor = "#ffffff", backgroundOpacity = 100, gradientStartColor = "#ffffff", gradientEndColor = "#d9f3f1", gradientAngle = 135, flatten = false } = {}) {
  if (flatten || background === "color") {
    context.fillStyle = rgbaColor(backgroundColor, backgroundOpacity);
    context.fillRect(0, 0, width, height);
    return;
  }
  if (background !== "gradient") return;
  const distance = Math.hypot(width, height) / 2;
  const start = gradientPoint(gradientAngle, distance);
  const end = gradientPoint(Number(gradientAngle || 0) + 180, distance);
  const gradient = context.createLinearGradient(start.x, start.y, end.x, end.y);
  const opacity = Math.max(0, Math.min(100, Number(backgroundOpacity)));
  gradient.addColorStop(0, rgbaColor(gradientStartColor, opacity));
  gradient.addColorStop(1, rgbaColor(gradientEndColor, opacity));
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function drawImage(source, width, height, { background = "transparent", backgroundColor = "#ffffff", backgroundOpacity = 100, gradientStartColor = "#ffffff", gradientEndColor = "#d9f3f1", gradientAngle = 135, preserveAspectRatio = true, flatten = false } = {}) {
  const { canvas, context } = createCanvas(width, height);
  fillBackground(context, width, height, { background, backgroundColor, backgroundOpacity, gradientStartColor, gradientEndColor, gradientAngle, flatten });
  const sourceWidth = source.naturalWidth || source.width || width;
  const sourceHeight = source.naturalHeight || source.height || height;
  const scale = preserveAspectRatio === false ? 1 : Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = preserveAspectRatio === false ? width : Math.max(1, Math.round(sourceWidth * scale));
  const drawHeight = preserveAspectRatio === false ? height : Math.max(1, Math.round(sourceHeight * scale));
  const offsetX = preserveAspectRatio === false ? 0 : Math.round((width - drawWidth) / 2);
  const offsetY = preserveAspectRatio === false ? 0 : Math.round((height - drawHeight) / 2);
  context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
  return { canvas, context, width, height };
}

function canvasHasTransparency(rendered) {
  const { context, width, height } = rendered;
  const stepX = Math.max(1, Math.floor(width / 32));
  const stepY = Math.max(1, Math.floor(height / 32));
  try {
    for (let y = 0; y < height; y += stepY) {
      for (let x = 0; x < width; x += stepX) {
        if (context.getImageData(x, y, 1, 1).data[3] < 255) return true;
      }
    }
  } catch {
    // If pixel inspection is blocked by the browser, let the normal encoder
    // decide whether the image can be written instead of failing conversion.
  }
  return false;
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`This browser cannot create ${browserOutputLabel(mime === "image/jpeg" ? "jpeg" : "png")} output.`));
      }, mime, quality);
    } catch (error) {
      reject(browserProcessingError(error));
    }
  });
}

async function encodeImage(canvas, format, targetBytes, onProgress) {
  const mime = browserOutputMime(format);
  if (!mime) throw new Error(`Browser mode cannot create ${browserOutputLabel(format)} files. Use the Local agent for this format.`);
  if (format !== "jpeg" || !targetBytes) return { blob: await canvasBlob(canvas, mime), quality: undefined, targetMet: undefined, warnings: [] };

  let closest = null;
  let bestUnder = null;
  for (let quality = 95; quality >= 5; quality -= 10) {
    const blob = await canvasBlob(canvas, mime, quality / 100);
    const candidate = { blob, quality };
    const distance = Math.abs(blob.size - targetBytes);
    if (!closest || distance < Math.abs(closest.blob.size - targetBytes)) closest = candidate;
    if (blob.size <= targetBytes && (!bestUnder || blob.size > bestUnder.blob.size)) bestUnder = candidate;
    onProgress?.(Math.min(90, 35 + Math.round((95 - quality) / 90 * 55)), `Testing JPG quality ${quality}`);
  }
  const selected = bestUnder || closest;
  if (!selected) throw new Error("This browser could not create JPG output.");
  if (selected.blob.size < targetBytes) {
    onProgress?.(96, "Adjusting JPG size");
    const padded = await padJpegToTarget(selected.blob, targetBytes);
    const targetMet = Math.abs(padded.size - targetBytes) <= BROWSER_IMAGE_TARGET_TOLERANCE_BYTES;
    return {
      blob: padded,
      quality: selected.quality,
      targetMet,
      warnings: [`JPG quality was set to ${selected.quality} and the output was adjusted to approximately ${Math.round(targetBytes / 1000)} KB without changing pixel dimensions.`],
    };
  }
  const targetMet = Math.abs(selected.blob.size - targetBytes) <= BROWSER_IMAGE_TARGET_TOLERANCE_BYTES;
  return {
    blob: selected.blob,
    quality: selected.quality,
    targetMet,
    warnings: [targetMet
      ? `JPG quality was set to ${selected.quality} to target approximately ${Math.round(targetBytes / 1000)} KB.`
      : `The ${Math.round(targetBytes / 1000)} KB JPG target could not be reached without changing pixel dimensions; the closest safe result was kept.`],
  };
}

export async function padJpegToTarget(blob, targetBytes) {
  if (!blob || blob.size >= targetBytes) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let insertionPoint = bytes.length;
  for (let index = 0; index < bytes.length - 1; index += 1) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xda) {
      insertionPoint = index;
      break;
    }
  }
  if (insertionPoint === bytes.length) {
    for (let index = bytes.length - 2; index >= 0; index -= 1) {
      if (bytes[index] === 0xff && bytes[index + 1] === 0xd9) {
        insertionPoint = index;
        break;
      }
    }
  }
  let remaining = Math.max(0, Math.floor(targetBytes) - bytes.length);
  const segments = [];
  while (remaining > 0) {
    let segmentLength = Math.min(65537, remaining);
    const remainder = remaining - segmentLength;
    if (remainder > 0 && remainder < 4) segmentLength -= 4 - remainder;
    if (segmentLength < 4) segmentLength = 4;
    const payloadLength = segmentLength - 4;
    const segment = new Uint8Array(segmentLength);
    segment[0] = 0xff;
    segment[1] = 0xfe;
    segment[2] = (payloadLength + 2) >> 8;
    segment[3] = (payloadLength + 2) & 0xff;
    segments.push(segment);
    remaining -= segmentLength;
  }
  return new Blob([bytes.slice(0, insertionPoint), ...segments, bytes.slice(insertionPoint)], { type: "image/jpeg" });
}

function browserPdfCompressionSettings(profile, customQuality) {
  if (profile === "small") return { quality: 58, maxImageDimension: 1600, rasterDpi: 72 };
  if (profile === "quality") return { quality: 84, maxImageDimension: 3000, rasterDpi: 120 };
  if (profile === "custom") {
    const quality = Math.max(25, Math.min(90, Number(customQuality) || 72));
    const qualityProgress = (quality - 25) / 65;
    return { quality, maxImageDimension: Math.round(1200 + qualityProgress * 1800), rasterDpi: Math.round(72 + qualityProgress * 48) };
  }
  return { quality: 72, maxImageDimension: 2200, rasterDpi: 96 };
}

function browserPdfImageOperations(OPS) {
  return new Set([
    "paintImageXObject",
    "paintInlineImageXObject",
    "paintImageXObjectRepeat",
    "paintInlineImageXObjectGroup",
    "paintImageMaskXObject",
    "paintImageMaskXObjectGroup",
    "paintImageMaskXObjectRepeat",
  ].map((name) => OPS?.[name]).filter((value) => Number.isFinite(value)));
}

function browserPdfPageImageInfo(operatorList, imageOperations) {
  let count = 0;
  let totalPixels = 0;
  let largestPixels = 0;
  for (const [index, operation] of operatorList.fnArray.entries()) {
    if (!imageOperations.has(operation)) continue;
    const args = operatorList.argsArray[index] || [];
    const imageData = Array.isArray(args[0]) ? args[0][0] : args[0];
    const width = Number(args[1] || imageData?.width || 0);
    const height = Number(args[2] || imageData?.height || 0);
    const pixels = width > 0 && height > 0 ? width * height : 0;
    count += 1;
    totalPixels += pixels;
    largestPixels = Math.max(largestPixels, pixels);
  }
  return { count, totalPixels, largestPixels };
}

function browserPdfPageNeedsRaster(info, hasText) {
  return info.count > 0 && (!hasText || info.largestPixels >= 500_000 || info.totalPixels >= 1_000_000);
}

async function renderBrowserPdfPage(page, settings) {
  const requestedScale = settings.rasterDpi / 72;
  const requestedViewport = page.getViewport({ scale: requestedScale, rotation: page.rotate || 0 });
  const requestedPixels = requestedViewport.width * requestedViewport.height;
  const dimensionScale = Math.min(
    1,
    settings.maxImageDimension / Math.max(requestedViewport.width, requestedViewport.height),
    Math.sqrt(16_000_000 / Math.max(1, requestedPixels)),
  );
  const actualScale = requestedScale * dimensionScale;
  const viewport = page.getViewport({ scale: actualScale, rotation: page.rotate || 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("The browser could not create a PDF canvas.");
  context.filter = settings.removeColor ? "grayscale(1)" : "none";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  let blob;
  try {
    blob = await canvasBlob(canvas, "image/jpeg", settings.quality / 100);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
  return { blob, width: viewport.width / actualScale, height: viewport.height / actualScale };
}

function browserPdfOutputName(filename) {
  const stem = String(filename || "document.pdf").replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "document";
  return `${stem}_compressed.pdf`;
}

function browserPdfTextOutputName(filename) {
  return `${safeStem(filename || "document.pdf")}_edited.pdf`;
}

function browserPdfTextEditIsPlain(edit) {
  if (!edit || edit.mode === "ocr" || edit.moveOnly || edit.format) return false;
  if (Object.prototype.hasOwnProperty.call(edit, "offsetX") || Object.prototype.hasOwnProperty.call(edit, "offsetY")) return false;
  if (Object.prototype.hasOwnProperty.call(edit, "scale") || Object.prototype.hasOwnProperty.call(edit, "scaleX") || Object.prototype.hasOwnProperty.call(edit, "scaleY") || Object.prototype.hasOwnProperty.call(edit, "rotation")) return false;
  return typeof edit.replacementText === "string";
}

/**
 * Rewrite only native, selectable PDF text in Browser mode. This deliberately
 * accepts a small plain-text payload so formatting, placement, OCR, and
 * password handling cannot accidentally fall through to the Local-agent
 * export path.
 */
export async function processBrowserPdfTextEdits(source, edits = [], { onProgress } = {}) {
  if (!source || Number(source.size) > BROWSER_PDF_TEXT_EDITOR_MAX_BYTES) {
    throw new Error("Browser mode supports PDF text editing for PDFs up to 25 MB. Use the Local agent for larger PDFs.");
  }
  if (!Array.isArray(edits) || !edits.length || edits.some((edit) => !browserPdfTextEditIsPlain(edit))) {
    throw new Error("This project contains Local-agent-only text styling or placement changes. Switch to Local agent to export it.");
  }
  onProgress?.(5, "Reading PDF");
  let pdf;
  try {
    const [pdfjs, previewModule] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("../lib/pdf-text-preview.js"),
    ]);
    if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = "/api/pdf/worker";
    const sourceBytes = new Uint8Array(await source.arrayBuffer());
    const pdfBytes = sourceBytes.slice();
    const task = pdfjs.getDocument({ data: pdfBytes, useSystemFonts: true });
    task.onPassword = (callback) => callback(null);
    pdf = await task.promise;
    onProgress?.(18, "Validating selectable text");
    if (pdf.numPages > BROWSER_PDF_TEXT_EDITOR_MAX_PAGES) {
      throw new Error(`Browser mode supports PDFs with up to ${BROWSER_PDF_TEXT_EDITOR_MAX_PAGES} pages. Use the Local agent for longer documents.`);
    }
    onProgress?.(72, "Writing edited PDF");
    const outputBytes = await previewModule.createPdfTextPreview(sourceBytes, edits);
    const blob = new Blob([outputBytes], { type: "application/pdf" });
    onProgress?.(100, "PDF text export complete");
    return {
      blob,
      result: {
        filename: browserPdfTextOutputName(source.name),
        bytes: blob.size,
        inputBytes: source.size,
        pageCount: pdf.numPages,
        editCount: edits.length,
        method: "Browser PDF text replacement",
        warnings: [],
      },
    };
  } catch (error) {
    if (error?.name === "PasswordException" || /password|encrypted/i.test(error?.message || "")) {
      throw new Error("Password-protected PDFs require Local agent. Switch to Local agent to continue.");
    }
    throw browserProcessingError(error);
  } finally {
    await pdf?.cleanup?.();
    await pdf?.destroy?.();
  }
}

/**
 * Compress small PDFs without sending them to the Local agent. Image-heavy
 * pages are rendered to bounded JPEGs; pages without large raster content are
 * copied so ordinary vector/text pages do not lose their structure. Rebuilt
 * text-heavy pages can lose selectable text, which is why Local agent remains
 * the recommended path for searchable or larger documents.
 */
export async function processBrowserPdfCompression(source, { profile = "balanced", customQuality = 72, removeColor = false, customTargetMb = "" } = {}, { onProgress } = {}) {
  if (!source || source.size > BROWSER_PDF_MAX_BYTES) {
    throw new Error("Browser mode supports PDFs up to 10 MB. Use the Local agent for larger documents.");
  }
  onProgress?.(5, "Reading PDF");
  let pdf;
  try {
    const [pdfjs, pdfLib] = await Promise.all([
      import("pdfjs-dist/legacy/build/pdf.mjs"),
      import("pdf-lib"),
    ]);
    if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = "/api/pdf/worker";
    const sourceBytes = new Uint8Array(await source.arrayBuffer());
    const sourceForPdfLib = new Uint8Array(sourceBytes);
    pdf = await pdfjs.getDocument({ data: sourceBytes, useSystemFonts: true }).promise;
    if (pdf.numPages > 100) throw new Error("Browser mode supports PDFs with up to 100 pages. Use the Local agent for longer documents.");
    const imageOperations = browserPdfImageOperations(pdfjs.OPS);
    const plans = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const hasText = (content?.items || []).some((item) => String(item?.str || "").trim());
      const info = browserPdfPageImageInfo(await page.getOperatorList(), imageOperations);
      plans.push({ index, hasText, rasterize: browserPdfPageNeedsRaster(info, hasText) });
      page.cleanup?.();
      onProgress?.(5 + Math.round((index / pdf.numPages) * 25), `Checking page ${index} of ${pdf.numPages}`);
    }
    const rasterizedPlan = plans.filter((plan) => plan.rasterize);
    if (!rasterizedPlan.length) {
      return {
        blob: source,
        result: {
          filename: browserPdfOutputName(source.name),
          bytes: source.size,
          inputBytes: source.size,
          reductionPercent: 0,
          pageCount: pdf.numPages,
          rasterizedPages: 0,
          preservedPages: pdf.numPages,
          method: "Browser PDF compression (original kept)",
          warnings: ["This PDF has no large raster pages to optimize, so the original was kept to avoid making it larger."],
        },
      };
    }

    const sourceDocument = await pdfLib.PDFDocument.load(sourceForPdfLib, { updateMetadata: false, throwOnInvalidObject: false });
    const output = await pdfLib.PDFDocument.create();
    const requestedTargetMb = profile === "custom" ? Number(customTargetMb) : 0;
    const targetBytes = Number.isFinite(requestedTargetMb) && requestedTargetMb > 0 ? requestedTargetMb * 1000 * 1000 : 0;
    let settings = browserPdfCompressionSettings(profile, customQuality);
    if (targetBytes && targetBytes < source.size) {
      const targetRatio = Math.max(0.12, targetBytes / source.size);
      const targetScale = Math.sqrt(targetRatio);
      settings = {
        ...settings,
        quality: Math.max(25, Math.min(settings.quality, Math.round(settings.quality * targetScale))),
        maxImageDimension: Math.max(900, Math.round(settings.maxImageDimension * targetScale)),
      };
    }
    let rasterizedPages = 0;
    let preservedPages = 0;
    let rasterizedTextPages = 0;
    for (const [offset, plan] of plans.entries()) {
      const sourcePage = sourceDocument.getPage(offset);
      if (!plan.rasterize) {
        const embedded = await output.embedPage(sourcePage);
        const outputPage = output.addPage([sourcePage.getWidth(), sourcePage.getHeight()]);
        outputPage.drawPage(embedded);
        const rotation = sourcePage.getRotation?.().angle;
        if ([0, 90, 180, 270].includes(rotation)) outputPage.setRotation(pdfLib.degrees(rotation));
        preservedPages += 1;
      } else {
        const page = await pdf.getPage(plan.index);
        const rendered = await renderBrowserPdfPage(page, { ...settings, removeColor: profile === "custom" && removeColor });
        const image = await output.embedJpg(new Uint8Array(await rendered.blob.arrayBuffer()));
        const outputPage = output.addPage([rendered.width, rendered.height]);
        outputPage.drawImage(image, { x: 0, y: 0, width: rendered.width, height: rendered.height });
        if (plan.hasText) rasterizedTextPages += 1;
        rasterizedPages += 1;
        page.cleanup?.();
      }
      onProgress?.(35 + Math.round(((offset + 1) / plans.length) * 55), `Compressing page ${offset + 1} of ${plans.length}`);
    }
    onProgress?.(95, "Writing compressed PDF");
    const outputBytes = await output.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
    const smaller = outputBytes.byteLength < source.size;
    const warnings = [];
    if (rasterizedTextPages) warnings.push("Browser mode rebuilt image-heavy pages as JPEGs; selectable text on those pages may not be preserved. Use Local agent when searchable text matters.");
    if (targetBytes && outputBytes.byteLength > targetBytes) warnings.push(`The browser could not reach the ${requestedTargetMb} MB target without further reducing page quality; the best safe result was kept.`);
    if (!smaller) warnings.unshift("The compressed copy was not smaller, so the original was kept.");
    const blob = smaller ? new Blob([outputBytes], { type: "application/pdf" }) : source;
    onProgress?.(100, "Compression complete");
    return {
      blob,
      result: {
        filename: browserPdfOutputName(source.name),
        bytes: smaller ? outputBytes.byteLength : source.size,
        inputBytes: source.size,
        reductionPercent: smaller ? Math.max(0, Math.round((1 - outputBytes.byteLength / source.size) * 100)) : 0,
        targetSizeMb: targetBytes ? requestedTargetMb : undefined,
        targetMet: targetBytes ? outputBytes.byteLength <= targetBytes : undefined,
        pageCount: pdf.numPages,
        rasterizedPages,
        preservedPages,
        method: smaller ? "Browser PDF compression" : "Browser PDF compression (original kept)",
        warnings,
      },
    };
  } catch (error) {
    throw browserProcessingError(error);
  } finally {
    await pdf?.cleanup?.();
    await pdf?.destroy?.();
  }
}

export async function processBrowserImage(file, options = {}, { onProgress } = {}) {
  const format = String(options.format || "original");
  const targetBytes = options.maxSizeKb ? Number(options.maxSizeKb) * 1000 : 0;
  if (!file || file.size > BROWSER_IMAGE_MAX_BYTES) {
    throw new Error("Browser mode supports images up to 5 MB each. Use the Local agent for larger images.");
  }
  if (format !== "original" && !browserSupportsFormat(format)) throw new Error(`Browser mode cannot create ${browserOutputLabel(format)} files. Use the Local agent for this format.`);
  onProgress?.(10, "Reading image");
  if (format === "original") {
    return {
      blob: file,
      result: {
        filename: outputName(file.name, format),
        bytes: file.size,
        inputBytes: file.size,
        width: null,
        height: null,
        targetSizeKb: options.maxSizeKb || undefined,
        targetMet: undefined,
        inputFormat: imageExtension(file.name),
        outputFormat: imageExtension(file.name),
        method: "Browser file copy",
        warnings: [],
      },
    };
  }

  let decoded;
  try {
    decoded = await decodeImage(file);
    onProgress?.(25, "Rendering image");
    const rendered = drawImage(decoded.image, decoded.width, decoded.height);
    const hasTransparency = format === "jpeg" && canvasHasTransparency(rendered);
    const encodedCanvas = hasTransparency
      ? drawImage(decoded.image, decoded.width, decoded.height, { background: "color", backgroundColor: "#ffffff", flatten: true }).canvas
      : rendered.canvas;
    const encoded = await encodeImage(encodedCanvas, format, targetBytes, onProgress);
    const warnings = [...encoded.warnings];
    if (hasTransparency) warnings.unshift("JPG cannot preserve transparency; transparent pixels were flattened against white.");
    if (format === "png" && targetBytes && encoded.blob.size > targetBytes) warnings.push(`The ${Math.round(targetBytes / 1000)} KB PNG target could not be reached because Browser mode keeps the original pixel dimensions.`);
    onProgress?.(100, "Conversion complete");
    return {
      blob: encoded.blob,
      result: {
        filename: outputName(file.name, format),
        bytes: encoded.blob.size,
        inputBytes: file.size,
        width: decoded.width,
        height: decoded.height,
        quality: encoded.quality,
        targetSizeKb: options.maxSizeKb || undefined,
        targetMet: encoded.targetMet ?? (targetBytes ? encoded.blob.size <= targetBytes : undefined),
        inputFormat: imageExtension(file.name),
        outputFormat: format,
        method: "Browser canvas conversion",
        warnings,
      },
    };
  } catch (error) {
    throw browserProcessingError(error);
  } finally {
    if (decoded) URL.revokeObjectURL(decoded.url);
  }
}

export async function processBrowserSvg(source, rawOptions = {}, { onProgress } = {}) {
  let options;
  let decoded;
  try {
    onProgress?.(5, "Reading SVG source");
    const markup = normalizeSvgMarkup(await source.text());
    options = normalizeSvgOptions(rawOptions);
    onProgress?.(15, "SVG source validated");
    decoded = await decodeImage(new Blob([markup], { type: "image/svg+xml" }));
    const scale = options.scale === "custom" ? 1 : Number(options.scale) || 1;
    const width = options.scale === "custom" ? options.width : Math.max(1, Math.round(decoded.width * scale));
    const height = options.scale === "custom" ? options.height : Math.max(1, Math.round(decoded.height * scale));
    onProgress?.(55, `Rendering SVG at ${width} × ${height}`);
    const rendered = drawImage(decoded.image, width, height, { background: options.background, backgroundColor: options.backgroundColor, backgroundOpacity: options.backgroundOpacity, gradientStartColor: options.gradientStartColor, gradientEndColor: options.gradientEndColor, gradientAngle: options.gradientAngle, preserveAspectRatio: options.preserveAspectRatio });
    onProgress?.(90, "Creating PNG output");
    const blob = await canvasBlob(rendered.canvas, "image/png");
    onProgress?.(100, "Conversion complete.");
    return {
      blob,
      result: {
        filename: `${safeStem(source.name || "artwork.svg")}.png`,
        bytes: blob.size,
        inputBytes: source.size,
        width,
        height,
        inputFormat: "svg",
        outputFormat: "png",
        scale: options.scale,
        background: options.background,
        backgroundOpacity: options.backgroundOpacity,
        gradientAngle: options.background === "gradient" ? options.gradientAngle : undefined,
        preserveAspectRatio: options.preserveAspectRatio,
        method: "Browser canvas rasterization",
        warnings: [],
      },
    };
  } catch (error) {
    throw browserProcessingError(error);
  } finally {
    if (decoded) URL.revokeObjectURL(decoded.url);
  }
}
