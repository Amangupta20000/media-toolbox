import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";
import { applyRasterTextEdits } from "./pdf-ocr-raster.js";
import { normalizeTextFormat, scaleTextFormat } from "./pdf-text-format.js";

const require = createRequire(import.meta.url);
const OCR_SCALE = 2;
const CURRENCY_SYMBOLS = "₹$€£¥₽₩¢";
const currencyTokenPattern = new RegExp(`^[${CURRENCY_SYMBOLS}]$`, "u");
const currencyPrefixPattern = new RegExp(`^[${CURRENCY_SYMBOLS}]\\s*[-+]?\\d`, "u");
const currencyCandidatePattern = new RegExp(`^[${CURRENCY_SYMBOLS}]\\s*[-+]?\\d[\\d\\s.,%]*$`, "u");
const numericTokenPattern = new RegExp(`^[${CURRENCY_SYMBOLS}\\s]*[-+]?\\d[\\d\\s.,%${CURRENCY_SYMBOLS}]*$`, "u");

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

const commonShortWords = new Set("a i an as at be by do go he if in is it me my no oh on or so to up us we you".split(" "));

function isCurrencyToken(text) {
  return currencyTokenPattern.test(String(text || "").trim());
}

function isCurrencyCandidate(text) {
  return currencyCandidatePattern.test(String(text || "").replace(/\s+/g, ""));
}

function normalizeCurrencyText(text) {
  return String(text || "").replace(/\s+/g, "").trim();
}

function isNumericLikeText(text) {
  return numericTokenPattern.test(String(text || "").trim());
}

function shouldInsertWordSpace(left, right) {
  if (isCurrencyToken(left) || currencyPrefixPattern.test(String(left || "").trim())) return false;
  if (/^[,.;:%!?)]/u.test(String(right || "").trim())) return false;
  return true;
}

function isLikelyGraphicWord(word, text) {
  if (isCurrencyToken(text)) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  const confidence = Number(word.confidence);
  // Raster icons can be decoded as a tiny two-letter token (the attached
  // checkmark becomes `ow`) with zero confidence. Do not remove ordinary
  // short words, which are valid OCR content even when they are small.
  return Number.isFinite(confidence) && confidence <= 0 && text.length <= 3 && !commonShortWords.has(text.toLocaleLowerCase("en-US"));
}

export function wordsFromBlocks(blocks) {
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
          // OCR frequently turns checkmarks, bullets, circled icons, and
          // decorative marks into a short symbol-like "word". Keep these
          // detections as selectable artwork runs. They remain moveable,
          // resizable, and rotatable, but must never be replaced with an
          // approximated OCR font or merged into neighbouring text.
          if (isLikelyGraphicWord(word, text)) {
            words.push({ text, confidence: Number(word.confidence) || 0, bbox, graphic: true });
            continue;
          }
          const previous = words.at(-1);
          const gap = previous ? bbox.x0 - previous.bbox.x1 : Infinity;
          const sameLine = previous && !previous.graphic && bbox.y0 < previous.bbox.y1 && bbox.y1 > previous.bbox.y0;
          const maxWordGap = Math.max(10, (bbox.y1 - bbox.y0) * 1.8);
          if (sameLine && gap >= 0 && gap <= maxWordGap) {
            previous.text = `${previous.text}${shouldInsertWordSpace(previous.text, text) ? " " : ""}${text}`;
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

function verticalOverlapRatio(left, right) {
  const overlap = Math.max(0, Math.min(left.bbox.y1, right.bbox.y1) - Math.max(left.bbox.y0, right.bbox.y0));
  return overlap / Math.max(1, Math.min(left.bbox.y1 - left.bbox.y0, right.bbox.y1 - right.bbox.y0));
}

function horizontalDistance(left, right) {
  if (left.bbox.x1 < right.bbox.x0) return right.bbox.x0 - left.bbox.x1;
  if (right.bbox.x1 < left.bbox.x0) return left.bbox.x0 - right.bbox.x1;
  return 0;
}

function unionBox(left, right) {
  return {
    x0: Math.min(left.x0, right.x0),
    y0: Math.min(left.y0, right.y0),
    x1: Math.max(left.x1, right.x1),
    y1: Math.max(left.y1, right.y1),
  };
}

/**
 * Tesseract's English model can drop the rupee sign or confuse it with `$`
 * while still finding the numeric part. A second, symbol-focused pass uses
 * the Hindi model's currency glyph set and replaces only nearby numeric runs.
 * It never changes ordinary words or invents a currency mark without a
 * matching OCR candidate.
 */
export function mergeCurrencyWords(words, currencyWords) {
  const merged = (words || []).map((word) => ({ ...word, bbox: { ...word.bbox } }));
  for (const currencyWord of currencyWords || []) {
    const text = normalizeCurrencyText(currencyWord.text);
    if (!isCurrencyCandidate(text) || currencyWord.graphic) continue;
    const candidates = merged
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => !word.graphic && isNumericLikeText(word.text))
      .filter(({ word }) => verticalOverlapRatio(word, currencyWord) >= 0.35)
      .filter(({ word }) => horizontalDistance(word, currencyWord) <= Math.max(12, (currencyWord.bbox.y1 - currencyWord.bbox.y0) * 2.5))
      .sort((left, right) => {
        const leftScore = verticalOverlapRatio(left.word, currencyWord) * 3 - horizontalDistance(left.word, currencyWord) / Math.max(1, currencyWord.bbox.y1 - currencyWord.bbox.y0);
        const rightScore = verticalOverlapRatio(right.word, currencyWord) * 3 - horizontalDistance(right.word, currencyWord) / Math.max(1, currencyWord.bbox.y1 - currencyWord.bbox.y0);
        return rightScore - leftScore;
      });
    const match = candidates[0];
    if (match) {
      match.word.text = text;
      match.word.bbox = unionBox(match.word.bbox, currencyWord.bbox);
      match.word.confidence = Math.max(Number(match.word.confidence) || 0, Number(currencyWord.confidence) || 0);
      match.word.currency = true;
      continue;
    }
    // If the primary OCR pass missed the complete numeric token, retain a
    // symbol-prefixed candidate so it remains selectable and editable.
    merged.push({ ...currencyWord, text, bbox: { ...currencyWord.bbox }, graphic: false, currency: true });
  }
  return merged.sort((left, right) => left.bbox.y0 - right.bbox.y0 || left.bbox.x0 - right.bbox.x0);
}

function ocrRunId(pageIndex, ordinal, text, bbox, sourceHash) {
  const originalTextHash = sha256Hex(Buffer.from(text, "utf8"));
  const boxKey = [bbox.x0, bbox.y0, bbox.x1, bbox.y1].map((value) => Math.round(value * 10) / 10).join("-");
  return `p${pageIndex}-ocr-o${ordinal}-t${originalTextHash.slice(0, 16)}-b${sha256Hex(Buffer.from(boxKey)).slice(0, 12)}-f${sourceHash.slice(0, 16)}`;
}

function buildRun(pageIndex, ordinal, word, sourceHash, pageUnitScale = 1) {
  const originalTextHash = sha256Hex(Buffer.from(word.text, "utf8"));
  return {
    pageIndex,
    ordinal,
    runId: ocrRunId(pageIndex, ordinal, word.text, word.bbox, sourceHash),
    text: word.text,
    originalText: word.text,
    originalTextHash,
    bbox: word.bbox,
    // OCR coordinates are pixels from the 2x page render. Store the detected
    // height in PDF/page units so the formatting controls show the size of
    // this specific run instead of falling back to 18 for every OCR word.
    fontSize: Math.max(1, (word.bbox.y1 - word.bbox.y0) * pageUnitScale),
    confidence: word.confidence,
    mode: "ocr",
    graphic: Boolean(word.graphic),
    editable: !word.graphic,
    reason: word.graphic
      ? "OCR identified this as a symbol or graphic. Text replacement is disabled, but it can be moved, resized, and rotated."
      : "OCR text is editable as a visual reconstruction; the source PDF has no embedded text font to preserve.",
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

async function createCurrencyWorker() {
  const tesseract = await import("tesseract.js");
  const hindi = await import("@tesseract.js-data/hin");
  const createWorker = tesseract.createWorker || tesseract.default?.createWorker;
  if (!createWorker) throw new Error("The bundled OCR engine could not be loaded.");
  const corePath = path.dirname(require.resolve("tesseract.js-core/package.json"));
  const cachePath = path.join(os.tmpdir(), "media-toolbox-tesseract-cache");
  await fs.mkdir(cachePath, { recursive: true });
  const worker = await createWorker("hin", 1, {
    corePath,
    langPath: hindi.default?.langPath || hindi.langPath,
    gzip: hindi.default?.gzip !== false && hindi.gzip !== false,
    cachePath,
    logger: () => undefined,
  });
  await worker.setParameters({
    preserve_interword_spaces: "1",
    user_defined_dpi: "144",
    tessedit_pageseg_mode: "11",
    // This pass is deliberately restricted to common currency symbols and
    // numeric punctuation so it can recover a dropped `₹` without replacing
    // normal OCR words with Hindi-model guesses.
    tessedit_char_whitelist: `${CURRENCY_SYMBOLS}0123456789.,-+/%`,
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
  let currencyWorker = null;
  const pages = [];
  try {
    for (let position = 0; position < pagesToScan.length; position += 1) {
      const index = pagesToScan[position];
      activePageIndex = index;
      activePagePosition = position;
      const rendered = await renderPage(document, index + 1);
      const result = await worker.recognize(rendered.png, {}, { blocks: true });
      let words = wordsFromBlocks(result.data.blocks);
      if (words.some((word) => /\d/u.test(word.text))) {
        try {
          currencyWorker ||= await createCurrencyWorker();
          const currencyResult = await currencyWorker.recognize(rendered.png, {}, { blocks: true });
          let currencyWords = wordsFromBlocks(currencyResult.data.blocks);
          // Sparse-text mode is best for ordinary pages, but a tiny isolated
          // price can disappear after PDF.js anti-aliasing. A single-block
          // retry recovers that case without changing the primary OCR pass.
          if (!currencyWords.some((word) => isCurrencyCandidate(word.text))) {
            await currencyWorker.setParameters({ tessedit_pageseg_mode: "6" });
            const fallbackCurrencyResult = await currencyWorker.recognize(rendered.png, {}, { blocks: true });
            currencyWords = wordsFromBlocks(fallbackCurrencyResult.data.blocks);
            await currencyWorker.setParameters({ tessedit_pageseg_mode: "11" });
          }
          words = mergeCurrencyWords(words, currencyWords);
        } catch {
          // Currency recovery is an enhancement. If the optional Hindi model
          // is unavailable in a deployment, the normal English OCR result is
          // still valid and should be returned.
        }
      }
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
        runs: words.map((word, ordinal) => buildRun(index, ordinal, word, sourceHash, rendered.width / Math.max(1, rendered.imageWidth))),
      });
      emitProgress({ status: "page", pageIndex: index, progress: Math.round(((position + 1) / scanPageCount) * 100), message: `OCR scanned page ${index + 1} of ${document.numPages}.` });
    }
  } finally {
    await worker.terminate().catch(() => undefined);
    await currencyWorker?.terminate().catch(() => undefined);
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
    const offsetX = Number(edit.offsetX ?? 0);
    const offsetY = Number(edit.offsetY ?? 0);
    const scale = Number(edit.scale ?? 1);
    const scaleX = Number(edit.scaleX ?? scale);
    const scaleY = Number(edit.scaleY ?? scale);
    const rotation = Number(edit.rotation ?? 0);
    const format = edit.format === undefined ? null : normalizeTextFormat(edit.format, { fontSize: box.y1 - box.y0, color: "#000000" });
    if (edit.format !== undefined && (!edit.format || typeof edit.format !== "object" || !format)) throw new Error("OCR text formatting is invalid.");
    if (![offsetX, offsetY].every(Number.isFinite) || Math.abs(offsetX) > 100000 || Math.abs(offsetY) > 100000) throw new Error("OCR text movement must be a finite page offset within the PDF page.");
    if (![scale, scaleX, scaleY].every((value) => Number.isFinite(value) && value >= 0.25 && value <= 4) || !Number.isFinite(rotation) || Math.abs(rotation) > 100000) throw new Error("OCR text size and rotation must be within the supported range.");
    const list = pagesToEdit.get(pageIndex) || [];
    list.push({ ...edit, pageIndex, bbox: box, offsetX, offsetY, scale, scaleX, scaleY, rotation, ...(format ? { format } : {}) });
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
      const rasterEdits = editsForPage.map((edit) => ({
        ...edit,
        // The editor stores formatting in PDF/page units, while the OCR
        // raster is rendered at 2x. Keep the worker in the same coordinate
        // system as the browser preview so a preserved font size stays the
        // same size after export.
        ...(edit.format ? { format: scaleTextFormat(edit.format, rendered.imageWidth / Math.max(1, rendered.width)) } : {}),
        // OCR boxes and the preview use the displayed page coordinate system
        // (+Y down). Convert the persisted page-point movement to the worker's
        // raster pixels at the same scale used for OCR detection.
        offsetX: edit.offsetX * rendered.imageWidth / Math.max(1, rendered.width),
        offsetY: edit.offsetY * rendered.imageHeight / Math.max(1, rendered.height),
      }));
      warnings.push(...applyRasterTextEdits(rendered.canvas, rasterEdits, { availableFonts: rendered.availableFonts }));
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
