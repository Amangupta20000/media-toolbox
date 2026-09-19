import { createStoredZip } from "./zip.js";

export const PDF_TO_IMAGES_MAX_PAGES = 300;
export const PDF_TO_IMAGES_MAX_SCALE = 2;

let runtimePromise;
let sharpPromise;

async function runtime() {
  if (!runtimePromise) {
    runtimePromise = Promise.all([
      import("@napi-rs/canvas"),
      import("pdfjs-dist/legacy/build/pdf.mjs"),
    ]).then(([canvas, pdfjs]) => {
      globalThis.DOMMatrix ||= canvas.DOMMatrix;
      globalThis.ImageData ||= canvas.ImageData;
      globalThis.Path2D ||= canvas.Path2D;
      return { canvas, pdfjs };
    });
  }
  return runtimePromise;
}

async function sharp() {
  if (!sharpPromise) sharpPromise = import("sharp").then((module) => module.default || module);
  return sharpPromise;
}

function inputBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

function numberInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

export async function renderPdfToImageArchive(input, {
  format = "png",
  scale = 1.5,
  quality = 90,
  maxPages = PDF_TO_IMAGES_MAX_PAGES,
  onProgress,
} = {}) {
  const outputFormat = String(format).toLowerCase() === "jpg" ? "jpg" : "png";
  const outputScale = numberInRange(scale, 1.5, 1, PDF_TO_IMAGES_MAX_SCALE);
  const outputQuality = Math.round(numberInRange(quality, 90, 50, 100));
  const { canvas, pdfjs } = await runtime();
  const task = pdfjs.getDocument({ data: new Uint8Array(inputBytes(input)), disableWorker: true, useSystemFonts: true });
  const document = await task.promise;
  try {
    if (document.numPages > maxPages) throw new Error(`This PDF has ${document.numPages} pages. PDF to images supports up to ${maxPages} pages per export.`);
    const entries = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: outputScale, rotation: page.rotate || 0 });
      const rendered = canvas.createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      const context = rendered.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, rendered.width, rendered.height);
      await page.render({ canvasContext: context, viewport }).promise;
      let data = rendered.toBuffer("image/png");
      let extension = "png";
      if (outputFormat === "jpg") {
        const imageSharp = await sharp();
        data = await imageSharp(data).jpeg({ quality: outputQuality, progressive: true, chromaSubsampling: outputQuality < 75 ? "4:2:0" : "4:4:4" }).toBuffer();
        extension = "jpg";
      }
      entries.push({ name: `page-${String(pageNumber).padStart(3, "0")}.${extension}`, data });
      page.cleanup?.();
      onProgress?.(Math.round((pageNumber / document.numPages) * 90), `Rendering page ${pageNumber} of ${document.numPages}`);
    }
    const archive = createStoredZip(entries);
    onProgress?.(100, `Created ${entries.length} image${entries.length === 1 ? "" : "s"} in a ZIP archive`);
    return { bytes: archive, pageCount: document.numPages, format: outputFormat, scale: outputScale, quality: outputQuality };
  } finally {
    await document.cleanup?.();
    await document.destroy?.();
  }
}
