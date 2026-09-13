import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";
import { applyRasterTextEdits } from "./pdf-ocr-raster.js";

const require = createRequire(import.meta.url);
const OCR_SCALE = 2;

function bytesFor(value) {
  if (value instanceof Uint8Array && value.constructor === Uint8Array) return value;
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(Buffer.from(bytesFor(value))).digest("hex");
}

async function runtime() {
  const canvas = await import("@napi-rs/canvas");
  // PDF.js expects these browser canvas globals even when it is rendering in
  // Node. They are provided by the bundled native canvas implementation.
  globalThis.DOMMatrix ||= canvas.DOMMatrix;
  globalThis.ImageData ||= canvas.ImageData;
  globalThis.Path2D ||= canvas.Path2D;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return { canvas, pdfjs };
}

async function loadPdf(bytes, password = "") {
  const { pdfjs } = await runtime();
  const task = pdfjs.getDocument({
    // PDF.js transfers/detaches the supplied ArrayBuffer in some Node
    // versions. Give it a copy so the original upload remains available for
    // hashing, validation, and export.
    data: new Uint8Array(bytesFor(bytes)),
    disableWorker: true,
    useSystemFonts: true,
    ...(password ? { password } : {}),
  });
  const document = await task.promise;
  return { document, pdfjs };
}

async function renderPage(document, pageNumber, scale = OCR_SCALE) {
  const { canvas } = await runtime();
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const output = canvas.createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
  await page.render({ canvasContext: output.getContext("2d", { alpha: false }), viewport }).promise;
  return {
    page,
    canvas: output,
    png: output.toBuffer("image/png"),
    imageWidth: output.width,
    imageHeight: output.height,
    width: viewport.width / scale,
    height: viewport.height / scale,
    rotation: page.rotate || 0,
    availableFonts: canvas.GlobalFonts?.families?.map((font) => font.family).filter(Boolean) || [],
  };
}

function wordsFromBlocks(blocks) {
  const words = [];
  for (const block of blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          const text = String(word.text || "").trim();
          if (!text || !word.bbox) continue;
          const bbox = {
            x0: Number(word.bbox.x0),
            y0: Number(word.bbox.y0),
            x1: Number(word.bbox.x1),
            y1: Number(word.bbox.y1),
          };
          if (![bbox.x0, bbox.y0, bbox.x1, bbox.y1].every(Number.isFinite) || bbox.x1 <= bbox.x0 || bbox.y1 <= bbox.y0) continue;
          const previous = words.at(-1);
          const gap = previous ? bbox.x0 - previous.bbox.x1 : Infinity;
          const sameLine = previous && bbox.y0 < previous.bbox.y1 && bbox.y1 > previous.bbox.y0;
          const maxWordGap = Math.max(10, (bbox.y1 - bbox.y0) * 1.8);
          if (sameLine && gap >= 0 && gap <= maxWordGap) {
            previous.text = `${previous.text} ${text}`;
            previous.bbox.x1 = Math.max(previous.bbox.x1, bbox.x1);
            previous.bbox.y0 = Math.min(previous.bbox.y0, bbox.y0);
            previous.bbox.y1 = Math.max(previous.bbox.y1, bbox.y1);
            previous.confidence = Math.min(previous.confidence, Number(word.confidence) || 0);
          } else {
            words.push({ text, confidence: Number(word.confidence) || 0, bbox });
          }
        }
      }
    }
  }
  return words;
}

function ocrRunId(pageIndex, ordinal, text, bbox, sourceHash) {
  const originalTextHash = sha256Hex(Buffer.from(text, "utf8"));
  const boxKey = [bbox.x0, bbox.y0, bbox.x1, bbox.y1].map((value) => Math.round(value * 10) / 10).join("-");
  return `p${pageIndex}-ocr-o${ordinal}-t${originalTextHash.slice(0, 16)}-b${sha256Hex(Buffer.from(boxKey)).slice(0, 12)}-f${sourceHash.slice(0, 16)}`;
}

function buildRun(pageIndex, ordinal, word, sourceHash) {
  const originalTextHash = sha256Hex(Buffer.from(word.text, "utf8"));
  return {
    pageIndex,
    ordinal,
    runId: ocrRunId(pageIndex, ordinal, word.text, word.bbox, sourceHash),
    text: word.text,
    originalText: word.text,
    originalTextHash,
    bbox: word.bbox,
    confidence: word.confidence,
    mode: "ocr",
    editable: true,
    reason: "OCR text is editable as a visual reconstruction; the source PDF has no embedded text font to preserve.",
  };
}

async function createOcrWorker(onProgress) {
  const tesseract = await import("tesseract.js");
  const english = await import("@tesseract.js-data/eng");
  const createWorker = tesseract.createWorker || tesseract.default?.createWorker;
  if (!createWorker) throw new Error("The bundled OCR engine could not be loaded.");
  const corePath = path.dirname(require.resolve("tesseract.js-core/package.json"));
  const cachePath = path.join(os.tmpdir(), "media-toolbox-tesseract-cache");
  await fs.mkdir(cachePath, { recursive: true });
  const worker = await createWorker("eng", 1, {
    corePath,
    langPath: english.langPath,
    gzip: english.gzip !== false,
    cachePath,
    logger: (message) => onProgress?.(message),
  });
  await worker.setParameters({
    preserve_interword_spaces: "1",
    user_defined_dpi: "144",
    // Slides and image-heavy PDFs often contain isolated text over artwork.
    // Sparse-text layout prevents Tesseract from clipping the first letters
    // of a line when it tries to fit the page into a document-style layout.
    tessedit_pageseg_mode: "11",
  });
  return worker;
}

export async function recognizePdfText(bytes, { password = "", onProgress, pageIndexes } = {}) {
  const input = bytesFor(bytes);
  const sourceHash = sha256Hex(input);
  const { document } = await loadPdf(input, password);
  const pageCount = document.numPages;
  const selectedPageIndexes = Array.isArray(pageIndexes)
    ? [...new Set(pageIndexes.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value < pageCount))].sort((left, right) => left - right)
    : [];
  const pagesToScan = selectedPageIndexes.length ? selectedPageIndexes : Array.from({ length: pageCount }, (_, index) => index);
  const scanPageCount = pagesToScan.length;
  let activePageIndex = -1;
  let activePagePosition = -1;
  let lastProgress = 0;
  const emitProgress = (event) => {
    const progress = Number(event?.progress);
    if (!Number.isFinite(progress)) return;
    lastProgress = Math.max(lastProgress, Math.min(100, Math.round(progress)));
    onProgress?.({ ...event, progress: lastProgress, pageCount });
  };
  const reportProgress = (message) => {
    if (typeof message === "number") {
      emitProgress({ status: "ocr", progress: message, pageIndex: activePageIndex });
      return;
    }
    const localProgress = Number(message?.progress);
    if (!Number.isFinite(localProgress)) return;
    // Tesseract reports progress from 0 to 1 for the current operation. Keep
    // engine setup in the first 10%, then map each page into the remaining
    // 90% so the UI reflects actual OCR work instead of staying at 1% until
    // the request finishes.
    const pageShare = 0.9 / Math.max(1, scanPageCount);
    const pageStart = activePagePosition < 0 ? 0 : 0.1 + activePagePosition * pageShare;
    emitProgress({
      status: String(message?.status || "ocr"),
      progress: Math.max(1, Math.min(99, Math.round((pageStart + localProgress * (activePageIndex < 0 ? 0.1 : pageShare)) * 100))),
      pageIndex: activePageIndex,
    });
  };
  const worker = await createOcrWorker(reportProgress);
  const pages = [];
  try {
    for (let position = 0; position < pagesToScan.length; position += 1) {
      const index = pagesToScan[position];
      activePageIndex = index;
      activePagePosition = position;
      const rendered = await renderPage(document, index + 1);
      const result = await worker.recognize(rendered.png, {}, { blocks: true });
      const words = wordsFromBlocks(result.data.blocks);
      pages.push({
        pageIndex: index,
        pageLabel: `Page ${index + 1}`,
        width: rendered.width,
        height: rendered.height,
        imageWidth: rendered.imageWidth,
        imageHeight: rendered.imageHeight,
        rotation: rendered.rotation,
        ocr: true,
        confidence: Number(result.data.confidence) || 0,
        runs: words.map((word, ordinal) => buildRun(index, ordinal, word, sourceHash)),
      });
      emitProgress({ status: "page", pageIndex: index, progress: Math.round(((position + 1) / scanPageCount) * 100), message: `OCR scanned page ${index + 1} of ${document.numPages}.` });
    }
  } finally {
    await worker.terminate().catch(() => undefined);
    await document.cleanup?.().catch(() => undefined);
    await document.destroy?.().catch(() => undefined);
  }
  return {
    sourceHash,
    pageCount,
    scannedPageCount: pages.length,
    pages,
    totalRuns: pages.reduce((total, page) => total + page.runs.length, 0),
    warnings: ["Some PDF pages have no usable visible text layer. OCR edits reconstruct only affected page regions and cannot guarantee the original font, opacity, or hidden image pixels."],
  };
}

function finiteBox(value) {
  if (!value || typeof value !== "object") return null;
  const box = {
    x0: Number(value.x0),
    y0: Number(value.y0),
    x1: Number(value.x1),
    y1: Number(value.y1),
  };
  return [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) && box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
}

export async function applyPdfOcrEdits(bytes, edits, { sourceHash = "", runSourceHash = sourceHash, password = "" } = {}) {
  const input = bytesFor(bytes);
  const actualHash = sha256Hex(input);
  if (sourceHash && sourceHash !== actualHash) throw new Error("The source PDF changed after OCR detection. Upload it again before exporting.");
  const normalized = Array.isArray(edits) ? edits : [];
  if (!normalized.length) throw new Error("Select and change at least one OCR text run before exporting.");
  const pagesToEdit = new Map();
  for (const edit of normalized) {
    const pageIndex = Number(edit.pageIndex);
    const box = finiteBox(edit.bbox);
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || !box) throw new Error("Each OCR edit must include a valid page region.");
    if (!/^[a-f0-9]{64}$/i.test(String(edit.originalTextHash || ""))) throw new Error("Each OCR edit must include its original text hash.");
    if (sha256Hex(Buffer.from(String(edit.originalText || ""), "utf8")) !== String(edit.originalTextHash).toLowerCase()) throw new Error("The OCR original text hash no longer matches its original value.");
    const runMatch = String(edit.runId || "").match(/^p(\d+)-ocr-o(\d+)-t([a-f0-9]{16})-b([a-f0-9]{12})-f([a-f0-9]{16})$/i);
    const expectedRunId = runMatch ? ocrRunId(pageIndex, Number(runMatch[2]), String(edit.originalText || ""), box, runSourceHash || actualHash) : "";
    if (!runMatch || Number(runMatch[1]) !== pageIndex || expectedRunId.toLowerCase() !== String(edit.runId).toLowerCase()) throw new Error("The OCR text run identity no longer matches its original page region.");
    if (String(edit.replacementText ?? "").includes("\n") || String(edit.replacementText ?? "").includes("\r")) throw new Error("OCR replacements must be one line.");
    const list = pagesToEdit.get(pageIndex) || [];
    list.push({ ...edit, pageIndex, bbox: box });
    pagesToEdit.set(pageIndex, list);
  }
  const { document } = await loadPdf(input, password);
  const sourceDocument = await PDFDocument.load(input, { updateMetadata: false, throwOnInvalidObject: false });
  const outputDocument = await PDFDocument.create();
  const warnings = ["OCR edits reconstruct affected page regions as images because the source PDF has no embedded text font. Exact original font, opacity, and hidden graphics cannot be preserved for those regions."];
  try {
    for (let index = 0; index < document.numPages; index += 1) {
      const sourcePage = sourceDocument.getPage(index);
      const editsForPage = pagesToEdit.get(index);
      if (!editsForPage?.length) {
        const [copied] = await outputDocument.copyPages(sourceDocument, [index]);
        outputDocument.addPage(copied);
        continue;
      }
      const rendered = await renderPage(document, index + 1);
      warnings.push(...applyRasterTextEdits(rendered.canvas, editsForPage, { availableFonts: rendered.availableFonts }));
      const size = sourcePage.getSize();
      const outputPage = outputDocument.addPage([size.width, size.height]);
      if (sourcePage.getRotation) outputPage.setRotation(sourcePage.getRotation());
      // renderPage captures its PNG before edits are applied. Re-encode the
      // canvas here so the exported page contains the replacement text.
      const image = await outputDocument.embedPng(rendered.canvas.toBuffer("image/png"));
      outputPage.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
    }
    const resultBytes = await outputDocument.save();
    return { bytes: resultBytes, warnings: [...new Set(warnings)] };
  } finally {
    await document.cleanup?.().catch(() => undefined);
    await document.destroy?.().catch(() => undefined);
  }
}
