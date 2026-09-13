import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, decodePDFRawStream, degrees, rgb } from "pdf-lib";

let sharpPromise;

const PROFILE_SETTINGS = {
  balanced: {
    label: "Balanced compression",
    quality: 72,
    maxImageDimension: 2200,
    rasterDpi: 96,
  },
  small: {
    label: "Smallest-file compression",
    quality: 58,
    maxImageDimension: 1600,
    rasterDpi: 72,
  },
  quality: {
    label: "Higher-quality compression",
    quality: 84,
    maxImageDimension: 3000,
    rasterDpi: 120,
  },
  custom: {
    label: "Custom compression",
    quality: 72,
    maxImageDimension: 2200,
    rasterDpi: 96,
    removeColor: false,
  },
};

let pdfRuntimePromise;

function filterNames(stream) {
  const filter = stream.dict.get(PDFName.of("Filter"));
  if (!filter) return [];
  if (filter instanceof PDFName) return [filter.toString().replace(/^\//, "")];
  if (filter instanceof PDFArray) {
    return filter.asArray().filter((item) => item instanceof PDFName).map((item) => item.toString().replace(/^\//, ""));
  }
  return [];
}

function numberFrom(stream, name) {
  const value = stream.dict.get(PDFName.of(name));
  return value instanceof PDFNumber ? value.asNumber() : null;
}

function nameFrom(stream, name) {
  const value = stream.dict.get(PDFName.of(name));
  return value instanceof PDFName ? value.toString().replace(/^\//, "") : "";
}

function hasMask(stream) {
  return stream.dict.has(PDFName.of("SMask")) || stream.dict.has(PDFName.of("Mask"));
}

function lookupDict(document, value) {
  if (value instanceof PDFDict) return value;
  return document.context.lookupMaybe(value, PDFDict);
}

function walkXObjectDictionary(document, xObjects, visit, visited = new Set()) {
  if (!(xObjects instanceof PDFDict) || visited.has(xObjects)) return;
  visited.add(xObjects);
  for (const [name, object] of xObjects.entries()) {
    const stream = document.context.lookupMaybe(object, PDFRawStream);
    if (!stream) continue;
    const entry = { name, object, stream, xObjects };
    visit(entry);
    if (nameFrom(stream, "Subtype") !== "Form") continue;
    const resources = lookupDict(document, stream.dict.get(PDFName.of("Resources")));
    const nestedXObjects = resources && lookupDict(document, resources.get(PDFName.of("XObject")));
    walkXObjectDictionary(document, nestedXObjects, visit, visited);
  }
}

function imageResourceEntries(document) {
  const entries = [];
  for (const page of document.getPages()) {
    const xObjects = page.node.normalizedEntries().XObject;
    walkXObjectDictionary(document, xObjects, (entry) => {
      if (nameFrom(entry.stream, "Subtype") === "Image") entries.push(entry);
    });
  }
  return entries;
}

function rawImageInput(stream) {
  const filters = filterNames(stream);
  if (filters.length === 1 && filters[0] === "DCTDecode") return { data: Buffer.from(stream.contents) };
  if (!filters.includes("FlateDecode") || filters.some((filter) => !["FlateDecode", "Predictor"].includes(filter))) return null;
  const bits = numberFrom(stream, "BitsPerComponent");
  const width = numberFrom(stream, "Width");
  const height = numberFrom(stream, "Height");
  const colorSpace = nameFrom(stream, "ColorSpace");
  const channels = colorSpace === "DeviceGray" ? 1 : colorSpace === "DeviceRGB" ? 3 : 0;
  if (bits !== 8 || !width || !height || !channels) return null;
  try {
    const decoded = decodePDFRawStream(stream).decode();
    return { data: Buffer.from(decoded), raw: { width, height, channels } };
  } catch {
    return null;
  }
}

async function loadSharp() {
  if (!sharpPromise) sharpPromise = import("sharp").then((module) => module.default || module).catch(() => null);
  return sharpPromise;
}

function candidateIsUseful(candidate, originalBytes) {
  // Leave a little room for the PDF image dictionary and object-stream
  // overhead. Replacing a resource that is only a few bytes smaller can make
  // the finished PDF larger than the source.
  return candidate.length < originalBytes * 0.97;
}

async function encodeJpeg(sharp, input, settings) {
  let image = sharp(input.data, input.raw ? { raw: input.raw } : { failOn: "none" });
  image = image.resize({
    width: settings.maxImageDimension,
    height: settings.maxImageDimension,
    fit: "inside",
    withoutEnlargement: true,
  });
  if (settings.removeColor) image = image.grayscale();
  return image.jpeg({
    quality: settings.quality,
    progressive: true,
    chromaSubsampling: settings.quality < 75 ? "4:2:0" : "4:4:4",
  }).toBuffer();
}

function refKey(value) {
  return typeof value?.toString === "function" ? value.toString() : "";
}

function referencedXObjectRefs(document) {
  const refs = new Set();
  for (const page of document.getPages()) {
    const xObjects = page.node.normalizedEntries().XObject;
    walkXObjectDictionary(document, xObjects, ({ object }) => {
      const key = refKey(object);
      if (key) refs.add(key);
    });
  }
  return refs;
}

async function loadPdfRuntime() {
  if (!pdfRuntimePromise) {
    pdfRuntimePromise = Promise.all([
      import("@napi-rs/canvas"),
      import("pdfjs-dist/legacy/build/pdf.mjs"),
    ]).then(([canvas, pdfjs]) => {
      globalThis.DOMMatrix ||= canvas.DOMMatrix;
      globalThis.ImageData ||= canvas.ImageData;
      globalThis.Path2D ||= canvas.Path2D;
      return { canvas, pdfjs };
    });
  }
  return pdfRuntimePromise;
}

function rasterProfile(settings) {
  return {
    scale: settings.rasterDpi / 72,
    quality: Math.max(48, settings.quality - 4),
  };
}

function textItems(content) {
  return (content?.items || []).filter((item) => String(item?.str || "").trim());
}

function imagePaintOperations(OPS) {
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

function pageImageInfo(operatorList, imageOperations) {
  let count = 0;
  let totalPixels = 0;
  let largestPixels = 0;
  for (const [index, operation] of operatorList.fnArray.entries()) {
    if (!imageOperations.has(operation)) continue;
    const args = operatorList.argsArray[index] || [];
    // Inline-image operations pass an ImageData-like object whose pixel buffer
    // is stored in `.data`; dimensions live on the object itself. Do not
    // replace the object with its buffer before reading width/height.
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

function imageHeavy(info) {
  // A large scan/photo is normally at least 500k source pixels. Small logos,
  // icons, and decorative masks should remain vector/resource content.
  return info.count > 0 && (info.largestPixels >= 500_000 || info.totalPixels >= 1_000_000);
}

async function renderPageJpeg(page, settings, canvas) {
  const raster = rasterProfile(settings);
  const viewport = page.getViewport({ scale: raster.scale, rotation: page.rotate || 0 });
  const rendered = canvas.createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  const context = rendered.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, rendered.width, rendered.height);
  await page.render({ canvasContext: context, viewport }).promise;
  let image = settings.sharp(rendered.toBuffer("image/png"))
    .resize({ width: settings.maxImageDimension, height: settings.maxImageDimension, fit: "inside", withoutEnlargement: true });
  if (settings.removeColor) image = image.grayscale();
  const encoded = await image.jpeg({ quality: raster.quality, progressive: true, chromaSubsampling: raster.quality < 75 ? "4:2:0" : "4:4:4" }).toBuffer();
  return { encoded, width: viewport.width / raster.scale, height: viewport.height / raster.scale, rotation: page.rotate || 0 };
}

function textOverlayPlacement(item, width, height, rotation) {
  const transform = Array.isArray(item?.transform) || ArrayBuffer.isView(item?.transform) ? item.transform : [];
  const a = Number(transform[0]) || 0;
  const b = Number(transform[1]) || 0;
  const rawX = Number(transform[4]) || 0;
  const rawY = Number(transform[5]) || 0;
  const angle = Math.atan2(b, a) * 180 / Math.PI;
  if (rotation === 90) return { x: rawY, y: width - rawX, rotation: angle + 90 };
  if (rotation === 180) return { x: width - rawX, y: height - rawY, rotation: angle + 180 };
  if (rotation === 270) return { x: height - rawY, y: rawX, rotation: angle + 270 };
  return { x: rawX, y: rawY, rotation: angle };
}

function addTextOverlay(page, content, font, width, height, rotation) {
  let overlaid = 0;
  for (const item of textItems(content)) {
    const text = String(item.str || "");
    const transform = Array.isArray(item.transform) || ArrayBuffer.isView(item.transform) ? item.transform : [];
    const size = Math.max(1, Math.hypot(Number(transform[0]) || 0, Number(transform[1]) || 0) || Number(item.height) || 10);
    const placement = textOverlayPlacement(item, width, height, rotation);
    try {
      // The raster already contains the visible glyphs. An invisible text
      // layer keeps copy/search working without changing the visual result.
      page.drawText(text, {
        x: placement.x,
        y: placement.y,
        size,
        font,
        color: rgb(1, 1, 1),
        opacity: 0,
        rotate: degrees(placement.rotation),
      });
      overlaid += 1;
    } catch {
      // Standard Helvetica cannot encode every Unicode script. The visible
      // raster remains correct; unsupported strings are simply not overlaid.
    }
  }
  return overlaid;
}

async function rasterizePdfPages(bytes, profile, { onProgress, allowSearchableText = true, compressionOptions = {} } = {}) {
  const settings = pdfCompressionSettings(profile, compressionOptions);
  if (!settings) throw new Error("Choose a supported compression level.");
  const sharp = await loadSharp();
  if (!sharp) return { changed: false, imageOnly: false, reason: "image engine unavailable" };
  const { canvas, pdfjs } = await loadPdfRuntime();
  const source = new Uint8Array(bytes instanceof Uint8Array ? bytes : Buffer.from(bytes));
  // PDF.js may detach or take ownership of the supplied ArrayBuffer while it
  // parses the document. Keep an independent copy for pdf-lib page copying.
  const sourceForPdfLib = new Uint8Array(source);
  const pdf = await pdfjs.getDocument({ data: source, disableWorker: true, useSystemFonts: true }).promise;
  let sourceDocument;
  try {
    const output = await PDFDocument.create();
    sourceDocument = await PDFDocument.load(sourceForPdfLib, { updateMetadata: false, throwOnInvalidObject: false });
    const imageOperations = imagePaintOperations(pdfjs.OPS);
    const imageOnlyPages = [];
    const heavyPages = [];
    const pageData = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const items = textItems(content);
      const info = pageImageInfo(await page.getOperatorList(), imageOperations);
      pageData.push({ page, content, items, info });
      if (!items.length) imageOnlyPages.push(index);
      if (imageHeavy(info)) heavyPages.push(index);
    }
    if (imageOnlyPages.length === pdf.numPages && !allowSearchableText) {
      // Keep the existing image-only contract: every page becomes a compact
      // JPEG and there is no searchable text layer to preserve.
    } else if (!allowSearchableText && imageOnlyPages.length !== pdf.numPages) {
      return { changed: false, imageOnly: false, pageCount: pdf.numPages };
    } else if (!imageOnlyPages.length && !heavyPages.length) {
      return { changed: false, imageOnly: false, pageCount: pdf.numPages, reason: "no image-heavy pages" };
    }
    const pagesToRasterize = imageOnlyPages.length === pdf.numPages ? new Set(imageOnlyPages) : new Set(heavyPages);
    const overlayFont = pagesToRasterize.size && !imageOnlyPages.length ? await output.embedFont(StandardFonts.Helvetica) : null;
    let rasterizedPages = 0;
    let preservedPages = 0;
    let overlaidText = 0;
    const raster = rasterProfile(settings);
    for (const [offset, data] of pageData.entries()) {
      const pageNumber = offset + 1;
      if (!pagesToRasterize.has(pageNumber)) {
        const sourcePage = sourceDocument.getPage(offset);
        const embedded = await output.embedPage(sourcePage);
        const outputPage = output.addPage([sourcePage.getWidth(), sourcePage.getHeight()]);
        outputPage.drawPage(embedded);
        const sourceRotation = sourcePage.getRotation?.().angle;
        if ([0, 90, 180, 270].includes(sourceRotation)) outputPage.setRotation(degrees(sourceRotation));
        preservedPages += 1;
        onProgress?.(pageNumber, pdf.numPages);
        continue;
      }
      const rendered = await renderPageJpeg(data.page, { ...settings, sharp }, canvas);
      const image = await output.embedJpg(rendered.encoded);
      const outputPage = output.addPage([rendered.width, rendered.height]);
      outputPage.drawImage(image, { x: 0, y: 0, width: rendered.width, height: rendered.height });
      if (overlayFont) overlaidText += addTextOverlay(outputPage, data.content, overlayFont, rendered.width, rendered.height, rendered.rotation);
      rasterizedPages += 1;
      onProgress?.(pageNumber, pdf.numPages);
      // Let the renderer release the page and canvas before the next large
      // raster is created; this matters for long scanned documents.
      await data.page.cleanup?.();
    }
    return {
      changed: rasterizedPages > 0,
      imageOnly: imageOnlyPages.length === pdf.numPages,
      imageHeavy: heavyPages.length > 0,
      pageCount: pdf.numPages,
      rasterizedPages,
      preservedPages,
      overlaidText,
      bytes: await output.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 }),
      settings,
      rasterScale: raster.scale,
    };
  } finally {
    await pdf.cleanup?.();
    await pdf.destroy?.();
  }
}

/**
 * Some PDFs store every visible page as a JPEG2000, CCITT, JBIG2, or inline
 * image. Those encodings are intentionally not decoded by pdf-lib. If such a
 * document has no searchable text, render the page once and rebuild it with a
 * predictable JPEG. This is the same visual strategy used by the aggressive
 * compression modes in online tools, while the direct resource pass above
 * still preserves text/vector PDFs whenever possible.
 */
export async function rasterizeImageOnlyPdf(bytes, profile = "balanced", { onProgress, compressionOptions } = {}) {
  return rasterizePdfPages(bytes, profile, { onProgress, allowSearchableText: false, compressionOptions });
}

/**
 * Rasterize only pages dominated by large images. Searchable text pages that
 * are rasterized receive an invisible Helvetica overlay so copy/search still
 * works, while unrelated vector/text pages are copied without rasterization.
 */
export async function rasterizeImageHeavyPdf(bytes, profile = "balanced", { onProgress, compressionOptions } = {}) {
  return rasterizePdfPages(bytes, profile, { onProgress, allowSearchableText: true, compressionOptions });
}

/**
 * Re-encode embedded, opaque page images while leaving page content streams,
 * text, vector graphics, and page geometry intact. This is the portable
 * fallback for workers where Ghostscript is unavailable.
 */
export async function recompressPdfImages(document, profile = "balanced", { onProgress, compressionOptions = {} } = {}) {
  const settings = pdfCompressionSettings(profile, compressionOptions);
  if (!settings) throw new Error("Choose a supported compression level.");
  const sharp = await loadSharp();
  if (!sharp) return { changed: false, replacements: 0, skipped: 0, reason: "image engine unavailable" };

  const entries = imageResourceEntries(document);
  const replacementRefs = new Map();
  const replacedOriginalRefs = new Map();
  let replacements = 0;
  let skipped = 0;

  for (const [index, entry] of entries.entries()) {
    onProgress?.(index + 1, entries.length);
    if (hasMask(entry.stream) || entry.stream.contents.length < 12 * 1024) {
      skipped += 1;
      continue;
    }
    const originalRef = refKey(entry.object);
    if (originalRef && replacementRefs.has(originalRef)) {
      entry.xObjects.set(entry.name, replacementRefs.get(originalRef));
      continue;
    }
    const input = rawImageInput(entry.stream);
    if (!input) {
      skipped += 1;
      continue;
    }
    let encoded;
    try {
      encoded = await encodeJpeg(sharp, input, settings);
    } catch {
      skipped += 1;
      continue;
    }
    if (!candidateIsUseful(encoded, entry.stream.contents.length)) {
      skipped += 1;
      continue;
    }
    try {
      const embedded = await document.embedJpg(encoded);
      await embedded.embed();
      entry.xObjects.set(entry.name, embedded.ref);
      if (originalRef) {
        replacementRefs.set(originalRef, embedded.ref);
        replacedOriginalRefs.set(originalRef, entry.object);
      }
      replacements += 1;
    } catch {
      skipped += 1;
    }
  }

  // pdf-lib serializes all registered indirect objects. Remove image objects
  // that no page resource points at anymore, otherwise the old high-quality
  // bytes would remain in the output despite the resource replacement.
  const stillReferenced = referencedXObjectRefs(document);
  for (const [key, object] of replacedOriginalRefs.entries()) {
    if (!stillReferenced.has(key) && object?.constructor?.name === "PDFRef") document.context.delete(object);
  }

  return {
    changed: replacements > 0,
    replacements,
    skipped,
    imageCount: entries.length,
    settings,
  };
}

export function pdfCompressionSettings(profile = "balanced", options = {}) {
  const base = PROFILE_SETTINGS[profile];
  if (!base) return null;
  if (profile !== "custom") return { ...base };
  const quality = Math.max(25, Math.min(90, Number.isFinite(Number(options.customQuality)) ? Number(options.customQuality) : base.quality));
  const qualityProgress = (quality - 25) / 65;
  return {
    ...base,
    quality,
    maxImageDimension: Math.round(1200 + qualityProgress * 1800),
    rasterDpi: Math.round(72 + qualityProgress * 48),
    removeColor: options.removeColor === true || ["1", "true", "on"].includes(String(options.removeColor || "").toLowerCase()),
  };
}
