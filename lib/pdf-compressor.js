import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from "pdf-lib";

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

async function hasSearchableText(pdf) {
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    if (content.items.some((item) => String(item.str || "").trim())) return true;
  }
  return false;
}

/**
 * Some PDFs store every visible page as a JPEG2000, CCITT, JBIG2, or inline
 * image. Those encodings are intentionally not decoded by pdf-lib. If such a
 * document has no searchable text, render the page once and rebuild it with a
 * predictable JPEG. This is the same visual strategy used by the aggressive
 * compression modes in online tools, while the direct resource pass above
 * still preserves text/vector PDFs whenever possible.
 */
export async function rasterizeImageOnlyPdf(bytes, profile = "balanced", { onProgress } = {}) {
  const settings = PROFILE_SETTINGS[profile];
  if (!settings) throw new Error("Choose a supported compression level.");
  const sharp = await loadSharp();
  if (!sharp) return { changed: false, imageOnly: false, reason: "image engine unavailable" };
  const { canvas, pdfjs } = await loadPdfRuntime();
  const source = new Uint8Array(bytes instanceof Uint8Array ? bytes : Buffer.from(bytes));
  const pdf = await pdfjs.getDocument({ data: source, disableWorker: true, useSystemFonts: true }).promise;
  try {
    if (await hasSearchableText(pdf)) return { changed: false, imageOnly: false, pageCount: pdf.numPages };
    const output = await PDFDocument.create();
    const raster = rasterProfile(settings);
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: raster.scale, rotation: page.rotate || 0 });
      const rendered = canvas.createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      const context = rendered.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, rendered.width, rendered.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const encoded = await sharp(rendered.toBuffer("image/png"))
        .resize({ width: settings.maxImageDimension, height: settings.maxImageDimension, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: raster.quality, progressive: true, chromaSubsampling: raster.quality < 75 ? "4:2:0" : "4:4:4" })
        .toBuffer();
      const image = await output.embedJpg(encoded);
      const width = viewport.width / raster.scale;
      const height = viewport.height / raster.scale;
      const outputPage = output.addPage([width, height]);
      outputPage.drawImage(image, { x: 0, y: 0, width, height });
      onProgress?.(index, pdf.numPages);
    }
    return {
      changed: true,
      imageOnly: true,
      pageCount: pdf.numPages,
      bytes: await output.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 }),
      settings,
    };
  } finally {
    await pdf.cleanup?.();
    await pdf.destroy?.();
  }
}

/**
 * Re-encode embedded, opaque page images while leaving page content streams,
 * text, vector graphics, and page geometry intact. This is the portable
 * fallback for workers where Ghostscript is unavailable.
 */
export async function recompressPdfImages(document, profile = "balanced", { onProgress } = {}) {
  const settings = PROFILE_SETTINGS[profile];
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

export function pdfCompressionSettings(profile = "balanced") {
  return PROFILE_SETTINGS[profile] || null;
}
