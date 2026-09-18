"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bold, CheckCircle2, Copy, Download, FilePlus2, FileText, GripVertical, ImagePlus, Italic, LoaderCircle, Lock, LockKeyhole, MoreHorizontal, Plus, Printer, Redo2, RotateCcw, RotateCw, Save, Trash2, Type, Underline, Undo2, Unlock, UploadCloud, WandSparkles, X, ZoomIn, ZoomOut } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { DismissibleMessage } from "./dismissible-message.jsx";
import { formatBytes } from "./file-dropzone.jsx";
import { takeHistoryEdit } from "./history-edit.js";
import { ProcessingMode } from "./processing-mode.jsx";
import { ResultDownloadNote } from "./result-download-note.jsx";
import { downloadFilename, downloadUrlWithFilename, filenameStem, ResultFilenameField } from "./result-filename.jsx";
import { ToolHistory, ToolViewTabs } from "./tool-history.jsx";
import { ToolFaqContent, ToolSeoContent } from "./tool-seo-content.jsx";
import { ProcessingOptionsPanel } from "./processing-options.jsx";
import { BROWSER_PDF_EDITOR_IMAGE_MAX_BYTES, BROWSER_PDF_EDITOR_MAX_TOTAL_BYTES } from "./browser-processing.js";
import { deleteProcessingJob, getProcessingJob, isProcessingLocationReady, preferredProcessingMode, probeProcessingLocations, uploadWithProgress } from "./processing-client.js";
import { MAX_PDF_COUNT, MAX_PDF_TOTAL_BYTES } from "../lib/pdf-limits.js";
import { normalizeImageRotation, rotatedImageDrawPlacement } from "../lib/pdf-image-placement.js";
import { assembleBrowserPdf, BROWSER_PDF_FIDELITY_WARNING } from "../lib/pdf-browser-editor.js";
import { calculatePreviewPageLayout, previewViewportLimits } from "../lib/pdf-preview-layout.js";
import { PDF_TEXT_BOX_FONTS, textBoxCssFontFamily, textBoxTextRuns } from "../lib/pdf-text-box.js";
import { pushAnalyticsEvent } from "../lib/analytics.js";

const MAX_IMAGE_COORDINATE = 100000;
const ACCEPTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".heif", ".tif", ".tiff", ".gif", ".bmp"]);
const BROWSER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const BROWSER_TEXT_BOX_ERROR = "Styled text boxes require Local agent. Switch to Local agent to continue.";
const BROWSER_DUPLICATE_PAGE_ERROR = "Duplicating pages requires Local agent. Switch to Local agent to continue.";
const BROWSER_PASSWORD_PDF_ERROR = "Password-protected PDFs require Local agent. Switch to Local agent to continue.";
const BROWSER_IMAGE_FORMAT_ERROR = "Browser mode accepts PNG, JPG, and JPEG images only. Use Local agent for other formats.";
const BROWSER_IMAGE_SIZE_ERROR = "Browser mode accepts images up to 1 MB each. Use Local agent for larger images.";
const BROWSER_PROJECT_ERROR = "This project contains a Local-agent-only feature. Switch to Local agent to export it.";
const A4 = { width: 595.28, height: 841.89, rotation: 0 };

function getPageImages(page) {
  if (Array.isArray(page?.images)) return page.images;
  return page?.image ? [{ ...page.image, id: page.image.id || "legacy-image" }] : [];
}

function getPageTextBoxes(page) {
  return Array.isArray(page?.textBoxes) ? page.textBoxes : [];
}

function validHexColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || ""));
}

const TEXT_BOX_STYLE_KEYS = ["fontFamily", "fontSize", "bold", "italic", "underline", "color", "backgroundColor"];

function textBoxRunPayload(run) {
  return { start: run.start, end: run.end, ...Object.fromEntries(TEXT_BOX_STYLE_KEYS.map((key) => [key, run[key]])) };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
}

function textBoxEditorHtml(textBox, scale) {
  return textBoxTextRuns(textBox).map((run) => {
    const color = validHexColor(run.color) ? run.color : "#173b53";
    const backgroundColor = run.backgroundColor === "transparent" || !validHexColor(run.backgroundColor) ? "transparent" : run.backgroundColor;
    const style = `font-family:${escapeHtml(textBoxCssFontFamily(run.fontFamily))};font-size:${Math.max(1, Number(run.fontSize) || 18) * scale}px;font-weight:${run.bold ? 700 : 400};font-style:${run.italic ? "italic" : "normal"};text-decoration:${run.underline ? "underline" : "none"};color:${color};background-color:${backgroundColor};white-space:pre-wrap`;
    return `<span style="${style}">${escapeHtml(run.text)}</span>`;
  }).join("");
}

function sameTextBoxRunStyle(left, right) {
  return TEXT_BOX_STYLE_KEYS.every((key) => left?.[key] === right?.[key]);
}

function compactTextBoxRuns(runs) {
  const compacted = [];
  for (const run of runs) {
    if (!run || run.end <= run.start) continue;
    const previous = compacted.at(-1);
    if (previous && previous.end === run.start && sameTextBoxRunStyle(previous, run)) previous.end = run.end;
    else compacted.push({ ...run });
  }
  return compacted.map(textBoxRunPayload);
}

function applyTextBoxRangeStyle(textBox, start, end, changes) {
  const runs = [];
  for (const run of textBoxTextRuns(textBox)) {
    if (run.end <= start || run.start >= end) {
      runs.push(run);
      continue;
    }
    if (run.start < start) runs.push({ ...run, end: start, text: textBox.text.slice(run.start, start) });
    const selectedStart = Math.max(run.start, start);
    const selectedEnd = Math.min(run.end, end);
    runs.push({ ...run, start: selectedStart, end: selectedEnd, text: textBox.text.slice(selectedStart, selectedEnd), ...changes });
    if (run.end > end) runs.push({ ...run, start: end, text: textBox.text.slice(end, run.end) });
  }
  return { ...textBox, runs: compactTextBoxRuns(runs) };
}

function applyTextBoxWholeStyle(textBox, changes) {
  const runs = textBoxTextRuns(textBox).map((run) => ({ ...run, ...changes }));
  return { ...textBox, ...changes, runs: compactTextBoxRuns(runs) };
}

function rebaseTextBoxRuns(textBox, nextText) {
  const previousText = String(textBox.text ?? "");
  const value = String(nextText ?? "");
  if (previousText === value) return Array.isArray(textBox.runs) ? textBox.runs : [];
  let prefix = 0;
  while (prefix < previousText.length && prefix < value.length && previousText[prefix] === value[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < previousText.length - prefix && suffix < value.length - prefix && previousText[previousText.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix += 1;
  const oldChangeEnd = previousText.length - suffix;
  const newChangeEnd = value.length - suffix;
  const sourceRuns = textBoxTextRuns(textBox);
  const result = [];
  for (const run of sourceRuns) {
    if (run.start < prefix) {
      const end = Math.min(run.end, prefix);
      if (end > run.start) result.push({ ...run, end, text: value.slice(run.start, end) });
    }
    const start = Math.max(run.start, oldChangeEnd);
    if (run.end > start) {
      const delta = value.length - previousText.length;
      result.push({ ...run, start: start + delta, end: run.end + delta, text: value.slice(start + delta, run.end + delta) });
    }
  }
  if (newChangeEnd > prefix) {
    const styleSource = sourceRuns.find((run) => run.start <= prefix && run.end > prefix) || sourceRuns.at(-1) || textBox;
    result.push({ ...styleSource, start: prefix, end: newChangeEnd, text: value.slice(prefix, newChangeEnd) });
  }
  return compactTextBoxRuns(result);
}

function textSelectionOffsets(root) {
  if (!root || typeof window === "undefined") return null;
  const selection = window.getSelection?.();
  if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return null;
  const range = selection.getRangeAt(0);
  const beforeStart = document.createRange();
  beforeStart.selectNodeContents(root);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const beforeEnd = document.createRange();
  beforeEnd.selectNodeContents(root);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  const start = beforeStart.toString().length;
  const end = beforeEnd.toString().length;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function restoreTextSelection(root, selection) {
  if (!root || !selection || typeof document === "undefined") return;
  const walker = document.createTreeWalker(root, document.defaultView?.NodeFilter?.SHOW_TEXT || 4);
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  const locate = (offset) => {
    let remaining = Math.max(0, offset);
    for (const textNode of nodes) {
      if (remaining <= textNode.nodeValue.length) return { node: textNode, offset: remaining };
      remaining -= textNode.nodeValue.length;
    }
    return nodes.length ? { node: nodes.at(-1), offset: nodes.at(-1).nodeValue.length } : { node: root, offset: 0 };
  };
  const start = locate(selection.start);
  const end = locate(selection.end);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const current = window.getSelection?.();
  current?.removeAllRanges();
  current?.addRange(range);
}

function textBoxPreviewStyle(page, textBox, scale = 1) {
  const placement = imageDisplayPlacement(page, textBox);
  const pageRotation = normalizeRotation(page?.rotation);
  const quarterTurn = pageRotation === 90 || pageRotation === 270;
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: quarterTurn ? `${Number(textBox.width) / Math.max(1, Number(placement.width)) * 100}%` : "100%",
    height: quarterTurn ? `${Number(textBox.height) / Math.max(1, Number(placement.height)) * 100}%` : "100%",
    display: "flex",
    alignItems: "stretch",
    justifyContent: "stretch",
    transform: `translate(-50%, -50%) rotate(${pageRotation}deg)`,
    transformOrigin: "center",
    overflow: "visible",
    fontSize: `${Math.max(1, Number(textBox.fontSize) || 18) * scale}px`,
    fontFamily: textBoxCssFontFamily(textBox.fontFamily),
    fontWeight: textBox.bold ? 700 : 400,
    fontStyle: textBox.italic ? "italic" : "normal",
    textDecoration: textBox.underline ? "underline" : "none",
    color: validHexColor(textBox.color) ? textBox.color : "#173b53",
    backgroundColor: textBox.backgroundColor === "transparent" ? "transparent" : validHexColor(textBox.backgroundColor) ? textBox.backgroundColor : "transparent",
  };
}

const PDF_OBJECT_HANDLE_DIRECTIONS = {
  "top-left": [-1, -1],
  top: [0, -1],
  "top-right": [1, -1],
  right: [1, 0],
  "bottom-right": [1, 1],
  bottom: [0, 1],
  "bottom-left": [-1, 1],
  left: [-1, 0],
};

function rotatePoint(point, angle) {
  const radians = angle * Math.PI / 180;
  return {
    x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
    y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
  };
}

function displayedDeltaToPage(page, dx, dy) {
  switch (normalizeRotation(page?.rotation)) {
    case 90: return { x: dy, y: -dx };
    case 180: return { x: -dx, y: -dy };
    case 270: return { x: -dy, y: dx };
    default: return { x: dx, y: dy };
  }
}

function objectFrameStyle(placement, rotation = 0) {
  return {
    ...imageOverlayFrameStyle(placement),
    transform: `rotate(${Number(rotation) || 0}deg)`,
    transformOrigin: "center center",
  };
}

function objectHandlePosition(handle) {
  const [directionX, directionY] = PDF_OBJECT_HANDLE_DIRECTIONS[handle] || [0, 0];
  return {
    left: directionX < 0 ? "0%" : directionX > 0 ? "100%" : "50%",
    top: directionY < 0 ? "0%" : directionY > 0 ? "100%" : "50%",
    transform: "translate(-50%, -50%)",
  };
}

function ObjectTransformHandles({ object, label, onResizeStart, onRotateStart }) {
  return <div className="pdf-object-transform-handles" aria-label={`${label} transform handles`}>
    {Object.keys(PDF_OBJECT_HANDLE_DIRECTIONS).map((handle) => <button key={handle} type="button" className={`pdf-object-resize-handle ${handle}`} style={objectHandlePosition(handle)} aria-label={`Resize ${label} from the ${handle} handle`} title="Drag to resize" onPointerDown={(event) => { event.stopPropagation(); onResizeStart?.(event, handle); }} />)}
    <button type="button" className="pdf-object-rotation-handle" style={{ left: "50%", top: "-28px", transform: "translate(-50%, -50%)" }} aria-label={`Rotate ${label}`} title="Drag to rotate" onPointerDown={(event) => { event.stopPropagation(); onRotateStart?.(event); }} />
  </div>;
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `page-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeRotation(value) {
  const rotation = Number(value) || 0;
  return ((rotation % 360) + 360) % 360;
}

function pageDisplayDimensions(page) {
  const rotation = normalizeRotation(page?.rotation);
  return rotation === 90 || rotation === 270
    ? { width: Number(page?.height) || A4.height, height: Number(page?.width) || A4.width }
    : { width: Number(page?.width) || A4.width, height: Number(page?.height) || A4.height };
}

function pageDisplayRatio(page) {
  const dimensions = pageDisplayDimensions(page);
  return dimensions.width / Math.max(1, dimensions.height);
}

function imageDisplayPlacement(page, image) {
  const pageWidth = Number(page?.width) || A4.width;
  const pageHeight = Number(page?.height) || A4.height;
  const x = Number(image?.x) || 0;
  const y = Number(image?.y) || 0;
  const width = Number(image?.width) || 0;
  const height = Number(image?.height) || 0;
  switch (normalizeRotation(page?.rotation)) {
    case 90:
      return { x: pageHeight - y - height, y: x, width: height, height: width, pageWidth: pageHeight, pageHeight: pageWidth };
    case 180:
      return { x: pageWidth - x - width, y: pageHeight - y - height, width, height, pageWidth, pageHeight };
    case 270:
      return { x: y, y: pageWidth - x - width, width: height, height: width, pageWidth: pageHeight, pageHeight: pageWidth };
    default:
      return { x, y, width, height, pageWidth, pageHeight };
  }
}

function validatePdfProject({ pages, pdfFiles, processingMode }) {
  if (!Array.isArray(pages) || pages.length === 0) return "Add at least one page before exporting.";
  if (pages.length > 2000) return "This PDF project has too many pages.";
  if (processingMode !== "browser" && (!Array.isArray(pdfFiles) || pdfFiles.length === 0) && pages.some((page) => page?.kind === "source" || page?.kind === "raster")) return "Add the source PDF for every source page before exporting.";
  const ids = new Set();
  for (const [index, page] of pages.entries()) {
    if (!page || typeof page !== "object" || ids.has(page.id)) return `Page ${index + 1} is invalid.`;
    ids.add(page.id);
    if (!["source", "raster", "blank"].includes(page.kind)) return `Page ${index + 1} has an unsupported type.`;
    const rawRotation = page.rotation === undefined ? 0 : Number(page.rotation);
    if (!Number.isFinite(rawRotation) || ![0, 90, 180, 270].includes(rawRotation)) return `Page ${index + 1} has an invalid rotation.`;
    const rotation = normalizeRotation(rawRotation);
    if (!Number.isFinite(Number(page.width)) || Number(page.width) <= 0 || !Number.isFinite(Number(page.height)) || Number(page.height) <= 0) return `Page ${index + 1} has invalid dimensions.`;
    if ((page.kind === "source" || page.kind === "raster") && (!Number.isInteger(page.pdfIndex) || page.pdfIndex < 0 || page.pdfIndex >= pdfFiles.length)) return `Page ${index + 1} points to an unavailable PDF.`;
    if (page.kind === "source" && (!Number.isInteger(page.pageIndex) || page.pageIndex < 0 || (Number.isInteger(pdfFiles[page.pdfIndex]?.pageCount) && page.pageIndex >= pdfFiles[page.pdfIndex].pageCount))) return `Page ${index + 1} points to an unavailable source page.`;
    for (const [imageIndex, image] of getPageImages(page).entries()) {
      if (!image || (!image.file && !image.sourceBytes)) return `Image ${imageIndex + 1} on page ${index + 1} is missing its source file.`;
      const values = [image.x, image.y, image.width, image.height].map(Number);
      const imageRotation = image.rotation === undefined ? 0 : Number(image.rotation);
      if (!values.every(Number.isFinite) || !Number.isFinite(imageRotation) || values[2] <= 0 || values[3] <= 0 || values[0] < -MAX_IMAGE_COORDINATE || values[1] < -MAX_IMAGE_COORDINATE || values[0] + values[2] > MAX_IMAGE_COORDINATE || values[1] + values[3] > MAX_IMAGE_COORDINATE) return `Image ${imageIndex + 1} on page ${index + 1} has an invalid placement or rotation.`;
    }
    for (const [textBoxIndex, textBox] of getPageTextBoxes(page).entries()) {
      const values = [textBox?.x, textBox?.y, textBox?.width, textBox?.height, textBox?.fontSize].map(Number);
      const textBoxRotation = textBox?.rotation === undefined ? 0 : Number(textBox.rotation);
      const fontFamily = String(textBox?.fontFamily || "Helvetica");
      const color = String(textBox?.color || "#173b53");
      const backgroundColor = String(textBox?.backgroundColor || "transparent");
      if (!textBox || typeof textBox !== "object" || !values.every(Number.isFinite) || !Number.isFinite(textBoxRotation) || values[2] <= 0 || values[3] <= 0 || values[4] < 1 || values[4] > 500 || values[0] < -MAX_IMAGE_COORDINATE || values[1] < -MAX_IMAGE_COORDINATE || values[0] + values[2] > MAX_IMAGE_COORDINATE || values[1] + values[3] > MAX_IMAGE_COORDINATE || !PDF_TEXT_BOX_FONTS.some((font) => font.value === fontFamily) || !validHexColor(color) || (backgroundColor !== "transparent" && !validHexColor(backgroundColor)) || String(textBox.text ?? "").length > 20000) return `Text box ${textBoxIndex + 1} on page ${index + 1} has invalid text or styling.`;
    }
  }
  return "";
}

function validatePdfResult(result, expectedPageCount) {
  if (!result || typeof result !== "object") return "The PDF export returned no result.";
  if (!result.downloadUrl || !result.filename) return "The PDF export returned no downloadable file.";
  if (!Number.isFinite(Number(result.bytes)) || Number(result.bytes) <= 0) return "The exported PDF is empty or its size could not be verified.";
  if (!Number.isInteger(Number(result.pageCount)) || Number(result.pageCount) < 1) return "The exported PDF page count could not be verified.";
  if (expectedPageCount && Number(result.pageCount) !== expectedPageCount) return `The exported PDF contains ${result.pageCount} pages, but ${expectedPageCount} were expected.`;
  return "";
}

function fileExtension(name) {
  const value = String(name || "").toLowerCase();
  return value.slice(value.lastIndexOf("."));
}

function isPdf(file) {
  return file && (file.type === "application/pdf" || fileExtension(file.name) === ".pdf");
}

function isImage(file) {
  return file && ((file.type || "").startsWith("image/") || ACCEPTED_IMAGE_EXTENSIONS.has(fileExtension(file.name)));
}

function isBrowserPdfEditorImage(file) {
  const type = String(file?.type || "").toLowerCase().split(";", 1)[0];
  const extension = fileExtension(file?.name);
  return (type === "image/png" || type === "image/jpeg" || !type) && BROWSER_IMAGE_EXTENSIONS.has(extension);
}

function browserPdfProjectError({ pages, pdfFiles = [] }) {
  const totalPdfBytes = pdfFiles.reduce((total, record) => total + Number(record?.file?.size || 0), 0);
  if (totalPdfBytes > BROWSER_PDF_EDITOR_MAX_TOTAL_BYTES) return "Browser mode accepts PDFs up to 50 MB total. Switch to Local agent for larger projects.";
  if ((pages || []).some((page) => page?.kind === "raster")) return BROWSER_PASSWORD_PDF_ERROR;
  for (const page of pages || []) {
    if (getPageTextBoxes(page).length) return BROWSER_TEXT_BOX_ERROR;
    for (const image of getPageImages(page)) {
      const file = image?.file;
      if (!file) return BROWSER_PROJECT_ERROR;
      if (!isBrowserPdfEditorImage(file)) return BROWSER_IMAGE_FORMAT_ERROR;
      if (Number(file.size) > BROWSER_PDF_EDITOR_IMAGE_MAX_BYTES) return BROWSER_IMAGE_SIZE_ERROR;
    }
  }
  return "";
}

function clipboardImageFile(blob, index) {
  const type = String(blob?.type || "image/png").toLowerCase();
  const subtype = type.split("/")[1]?.split(";")[0] || "png";
  const extension = subtype === "jpeg" ? "jpg" : subtype.replace(/[^a-z0-9]/g, "") || "png";
  return new File([blob], `pasted-image-${Date.now()}-${index + 1}.${extension}`, { type });
}

function clipboardImageFiles(clipboardData) {
  const clipboardFiles = Array.from(clipboardData?.files || []).filter((file) => isImage(file));
  if (clipboardFiles.length) return clipboardFiles.map((file, index) => clipboardImageFile(file, index));
  const items = Array.from(clipboardData?.items || []);
  return items
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item, index) => item.getAsFile())
    .filter(Boolean)
    .map((blob, index) => clipboardImageFile(blob, index));
}

async function loadPdfLibrary() {
  const library = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined" && library.GlobalWorkerOptions) {
    // Serve the worker through the traced Pages API route. This keeps the
    // worker available on Vercel even when generated public files are not
    // included by the platform's default Next.js build command.
    library.GlobalWorkerOptions.workerSrc = "/api/pdf/worker";
  }
  return library;
}

async function inspectPdfOnServer(file) {
  const form = new FormData();
  form.append("pdf", file, file.name);
  const response = await fetch("/api/pdf/inspect", { method: "POST", body: form, cache: "no-store" });
  let payload = {};
  try { payload = await response.json(); } catch { /* no-op */ }
  if (!response.ok) throw new Error(payload.error || "The server could not read this PDF.");
  return payload;
}

async function loadPdfDocumentWithPassword(pdfLibrary, data, filename) {
  const task = pdfLibrary.getDocument({ data });
  let passwordProtected = false;
  let attempts = 0;
  task.onPassword = (callback, reason) => {
    passwordProtected = true;
    attempts += 1;
    const message = reason === 2
      ? `The password for ${filename} was incorrect. Enter it again.`
      : `Enter the password to open ${filename}.`;
    const password = typeof window !== "undefined" ? window.prompt(message) : null;
    if (password === null) {
      task.destroy();
      return;
    }
    if (!String(password)) {
      task.destroy();
      return;
    }
    callback(String(password));
  };
  try {
    const documentProxy = await task.promise;
    return { documentProxy, passwordProtected };
  } catch (error) {
    if (passwordProtected && attempts > 0) {
      throw new Error("The PDF password was missing or incorrect. The file was not opened.");
    }
    throw error;
  }
}

async function loadPdfFile(file, pdfLibrary, { allowServerFallback = false, browserOnly = false } = {}) {
  const data = new Uint8Array(await file.arrayBuffer());
  // PDF.js may transfer the input buffer to its worker. Keep an independent
  // copy for native Browser export so preview loading cannot detach the
  // original PDF bytes before pages are copied into the output document.
  const preservedData = data.slice();
  let browserError = null;
  if (pdfLibrary) {
    try {
      const loaded = await loadPdfDocumentWithPassword(pdfLibrary, data, file.name);
      return { data: preservedData, documentProxy: loaded.documentProxy, pageCount: loaded.documentProxy.numPages, fallbackDocument: null, pageSizes: null, serverFallback: false, passwordProtected: loaded.passwordProtected };
    } catch (error) {
      browserError = error;
    }
  }
  if (browserOnly) {
    throw new Error(browserError instanceof Error
      ? `This PDF could not be rendered in Browser mode: ${browserError.message}`
      : "This PDF could not be rendered in Browser mode. Switch to Local agent for this file.");
  }
  try {
    const { PDFDocument } = await import("pdf-lib");
    const fallbackDocument = await PDFDocument.load(preservedData);
    let inspection = null;
    if (allowServerFallback) {
      try { inspection = await inspectPdfOnServer(file); } catch { /* the local fallback can still provide page metadata */ }
    }
    return { data: preservedData, documentProxy: null, pageCount: fallbackDocument.getPageCount(), fallbackDocument, pageSizes: inspection?.pages || null, previewToken: inspection?.previewToken || null, serverFallback: false, passwordProtected: false };
  } catch (fallbackError) {
    if (!allowServerFallback) {
      const detail = fallbackError instanceof Error ? fallbackError.message : browserError?.message;
      throw new Error(detail ? `The PDF preview and editor parser could not read this PDF: ${detail}` : "This PDF could not be read. Connect the Local agent and try again.");
    }
    try {
      const inspection = await inspectPdfOnServer(file);
      return { data, documentProxy: null, pageCount: inspection.pageCount, fallbackDocument: null, pageSizes: inspection.pages, previewToken: inspection.previewToken, serverFallback: true, passwordProtected: false };
    } catch (serverError) {
      const detail = serverError instanceof Error ? serverError.message : fallbackError instanceof Error ? fallbackError.message : browserError?.message;
      throw new Error(detail || "The browser and Local agent PDF readers could not open this file.");
    }
  }
}

async function readImageSize(file) {
  if ((file.type || "") === "image/svg+xml") throw new Error("SVG images are not supported on PDF pages.");
  const url = URL.createObjectURL(file);
  try {
    const size = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error("The selected image could not be read in this browser."));
      image.src = url;
    });
    return size;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function pageDimensions(pdfPage) {
  const viewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
  return { width: viewport.width, height: viewport.height, rotation: pdfPage.rotate || 0 };
}

const PDF_EDITOR_THUMBNAIL_QUALITY = 1.25;

async function renderThumbnail(pdfDocument, pageNumber, rotation = 0) {
  const pdfPage = await pdfDocument.getPage(pageNumber);
  const dimensions = pageDimensions(pdfPage);
  const scale = Math.min(0.25 * PDF_EDITOR_THUMBNAIL_QUALITY, (124 * PDF_EDITOR_THUMBNAIL_QUALITY) / dimensions.height, (180 * PDF_EDITOR_THUMBNAIL_QUALITY) / dimensions.width);
  const viewport = pdfPage.getViewport({ scale, rotation: normalizeRotation(rotation) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  try {
    await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  } catch (error) {
    if (error && typeof error === "object") error.pageDimensions = dimensions;
    throw error;
  }
  return { thumbnail: canvas.toDataURL("image/jpeg", 0.76), ...dimensions };
}

function fallbackThumbnail(label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="220" viewBox="0 0 160 220"><rect width="160" height="220" fill="white"/><rect x="1" y="1" width="158" height="218" fill="none" stroke="#d8e3e8"/><text x="80" y="104" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#8da0ad">Preview unavailable</text><text x="80" y="125" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#8da0ad">${label}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then((value) => {
      window.clearTimeout(timer);
      resolve(value);
    }, (error) => {
      window.clearTimeout(timer);
      reject(error);
    });
  });
}

function dataUrlToBytes(dataUrl) {
  const encoded = String(dataUrl || "").split(",", 2)[1] || "";
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function renderPdfPageToJpeg(pdfPage) {
  const baseViewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
  const scale = Math.min(1, 1200 / Math.max(1, baseViewport.width));
  const viewport = pdfPage.getViewport({ scale, rotation: 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  await withTimeout(pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise, 15000, "A PDF page took too long to render in Browser mode.");
  return dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92));
}

async function rasterizeBrowserPage(page, sourceDocuments, preparedPage) {
  if (page.kind !== "source") return { kind: "blank", width: page.width, height: page.height, rotation: page.rotation || 0, images: preparedPage.images || [], textBoxes: preparedPage.textBoxes || [] };
  const documentProxy = sourceDocuments?.[page.pdfIndex];
  if (!documentProxy) throw new Error("This PDF page cannot be rendered in Browser mode. Connect the Local agent for this file.");
  const pdfPage = page.pdfPage || await withTimeout(documentProxy.getPage(page.pageIndex + 1), 60000, "A PDF page took too long to load in Browser mode.");
  const bytes = await renderPdfPageToJpeg(pdfPage);
  return { kind: "raster", width: page.width, height: page.height, rotation: page.rotation || 0, baseImage: { extension: ".jpg", bytes }, images: preparedPage.images || [], textBoxes: preparedPage.textBoxes || [] };
}

async function loadBrowserImage(bytes, mime, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    const image = new Image();
    await withTimeout(new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`The image ${name || "file"} could not be decoded in this browser.`));
      image.src = url;
    }), 30000, `The image ${name || "file"} took too long to decode in Browser mode.`);
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function composeBrowserPageJpeg(page, sourceDocuments, preparedPage) {
  const width = Math.max(1, Number(page.width) || A4.width);
  const height = Math.max(1, Number(page.height) || A4.height);
  if (page.kind !== "source" && !(preparedPage.images || []).length) return { bytes: null, width: 0, height: 0 };
  const scale = Math.min(1, 1600 / width, 1600 / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser could not prepare a PDF page canvas.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  if (page.kind === "source") {
    const rasterPage = await rasterizeBrowserPage(page, sourceDocuments, preparedPage);
    const baseImage = await loadBrowserImage(rasterPage.baseImage.bytes, "image/jpeg", page.sourceName);
    context.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
  }

  for (const image of preparedPage.images || []) {
    const mime = image.extension === ".png" ? "image/png" : "image/jpeg";
    const decoded = await loadBrowserImage(image.bytes, mime, image.name);
    const placement = rotatedImageDrawPlacement(image, height);
    context.save();
    context.translate((placement.x + placement.width / 2) * scale, canvas.height - (placement.y + placement.height / 2) * scale);
    context.rotate(-placement.rotation * Math.PI / 180);
    context.drawImage(decoded, -placement.width * scale / 2, -placement.height * scale / 2, placement.width * scale, placement.height * scale);
    context.restore();
  }

  return { bytes: dataUrlToBytes(canvas.toDataURL("image/jpeg", 0.92)), width: canvas.width, height: canvas.height };
}

async function exportPdfInBrowser(pdfFiles, pages, sourceDocuments, onProgress) {
  onProgress?.(1);
  for (const [index] of pdfFiles.entries()) onProgress?.(Math.max(2, Math.round(((index + 1) / Math.max(1, pdfFiles.length)) * 8)));

  const preparedPages = [];
  for (const [index, page] of pages.entries()) {
    const images = [];
    for (const image of getPageImages(page)) {
      const extension = fileExtension(image.file?.name);
      if (![".png", ".jpg", ".jpeg"].includes(extension)) throw new Error("Browser PDF mode supports PNG, JPG, and JPEG images. Connect the Local agent for HEIC and other image formats.");
      const bytes = image.sourceBytes
        ? new Uint8Array(image.sourceBytes).slice()
        : new Uint8Array(await withTimeout(image.file.arrayBuffer(), 30000, `Timed out while reading ${image.file.name}. Connect the Local agent for this file.`));
      images.push({ x: image.x, y: image.y, width: image.width, height: image.height, rotation: normalizeImageRotation(image.rotation), extension, bytes, name: image.file?.name });
    }
    preparedPages.push({ kind: page.kind, pdfIndex: page.pdfIndex, pageIndex: page.pageIndex, width: page.width, height: page.height, rotation: page.rotation, images, textBoxes: getPageTextBoxes(page) });
    onProgress?.(10 + Math.round(((index + 1) / Math.max(1, pages.length)) * 6));
  }
  onProgress?.(16);
  const assembled = await assembleBrowserPdf(pdfFiles, pages, preparedPages, {
    onProgress,
    rasterizePage: (page, preparedPage) => composeBrowserPageJpeg(page, sourceDocuments, preparedPage),
  });
  // Do not render the output preview as part of export. In some embedded browsers
  // PDF.js never settles after loading an in-memory PDF, which used to leave a
  // valid export stuck on the processing screen. PdfResultPreview renders the
  // same download URL independently after the job completes.
  const previewImages = [];
  const previewError = null;
  onProgress?.(100);
  const blob = new Blob([assembled.bytes], { type: "application/pdf" });
  const downloadUrl = URL.createObjectURL(blob);
  const filename = pdfFiles.length === 1
    ? `${pdfFiles[0].name.replace(/\.pdf$/i, "")}_edited.pdf`
    : pdfFiles.length > 1 ? "merged_edited.pdf" : "blank_pages_edited.pdf";
  return { filename, bytes: assembled.bytes.byteLength, pageCount: pages.length, nativePageCount: assembled.nativePageCount, fallbackPageCount: assembled.fallbackPageCount, fallbackPages: assembled.fallbackPages, method: assembled.method, warnings: assembled.warnings, fidelityWarning: assembled.warnings.includes(BROWSER_PDF_FIDELITY_WARNING), downloadUrl, previewUrl: downloadUrl, previewImages, previewError };
}

export function PdfEditor() {
  const [pdfLibrary, setPdfLibrary] = useState(null);
  const [pdfFiles, setPdfFiles] = useState([]);
  const [pages, setPages] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedObject, setSelectedObject] = useState(null);
  const [draggedId, setDraggedId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);
  const [dropPosition, setDropPosition] = useState(null);
  const [recentlyDroppedId, setRecentlyDroppedId] = useState(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [job, setJob] = useState(null);
  const [saveJob, setSaveJob] = useState(null);
  const [saveNotice, setSaveNotice] = useState(null);
  const [jobReplacementId, setJobReplacementId] = useState("");
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [pdfDragActive, setPdfDragActive] = useState(false);
  const [continuingFile, setContinuingFile] = useState(null);
  const [locations, setLocations] = useState(null);
  const [processingMode, setProcessingMode] = useState("local");
  const [jobMode, setJobMode] = useState("local");
  const [jobKeepResult, setJobKeepResult] = useState(false);
  const [resultFilenameStem, setResultFilenameStem] = useState("");
  const [previewZoom, setPreviewZoom] = useState(1);
  const [activeView, setActiveView] = useState("tool");
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const [mobileLayout, setMobileLayout] = useState(false);
  const [, setHistoryRevision] = useState(0);
  const pdfInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const pageListRef = useRef(null);
  const pageElementRefs = useRef(new Map());
  const previewScrollRef = useRef(null);
  const previewElementRefs = useRef(new Map());
  const keyboardThumbnailTargetRef = useRef(null);
  const dropAnimationTimerRef = useRef(null);
  const dragScrollFrameRef = useRef(null);
  const dragPointerRef = useRef({ x: 0, y: 0, forceBottom: false, forceRight: false, valid: false });
  const imageTargetPageIdRef = useRef(null);
  const draggedIdRef = useRef(null);
  const pointerPageDragRef = useRef(null);
  const pointerPageScrollRef = useRef(null);
  const suppressPageClickRef = useRef(false);
  const suppressPageClickTimerRef = useRef(null);
  const dropIntentRef = useRef({ targetId: null, position: null });
  const documentsRef = useRef([]);
  const imageUrlsRef = useRef(new Set());
  const browserResultUrlRef = useRef("");
  const pdfLibraryPromiseRef = useRef(null);
  const historyEditLoadedRef = useRef(false);
  const moreToolsRef = useRef(null);
  const resultFilenameTouchedRef = useRef(false);
  const retainedJobIdRef = useRef(null);
  const saveReplacementJobIdRef = useRef("");
  const pagesRef = useRef([]);
  const pdfFilesRef = useRef([]);
  const historyRef = useRef({ past: [], future: [] });
  const pendingHistoryRef = useRef(null);
  const historyTimerRef = useRef(null);

  const useLocalAgent = () => {
    setError("");
    setProcessingMode("local");
    setActiveView("processing");
  };

  const selectProcessingMode = (mode) => {
    if (mode === "browser") {
      const restriction = browserPdfProjectError({ pages: pagesRef.current, pdfFiles: pdfFilesRef.current });
      if (restriction) {
        setError(restriction);
        setActiveView("tool");
        return;
      }
    }
    setError("");
    setProcessingMode(mode);
    setActiveView("tool");
  };

  const ensurePdfLibrary = () => {
    if (!pdfLibraryPromiseRef.current) {
      pdfLibraryPromiseRef.current = loadPdfLibrary().catch((error) => {
        pdfLibraryPromiseRef.current = null;
        throw error;
      });
    }
    return pdfLibraryPromiseRef.current;
  };

  useEffect(() => {
    let active = true;
    ensurePdfLibrary().then((library) => { if (active) setPdfLibrary(library); }).catch(() => { if (active) setError("PDF preview support could not be loaded. Refresh and try again."); });
    return () => { active = false; };
  }, []);

  useEffect(() => { probeProcessingLocations({ tool: "pdf-editor" }).then((value) => { setLocations(value); setProcessingMode(preferredProcessingMode(value)); }).catch(() => undefined); }, []);

  // Saving to the device is a background persistence action. It still uses
  // the local worker to produce the PDF, but it must not replace the editor
  // with the export/result screen like an explicit Export PDF action does.
  useEffect(() => {
    if (!saveJob?.id) return undefined;
    let active = true;
    let timer = null;
    const poll = async () => {
      try {
        const current = await getProcessingJob("local", saveJob.id);
        if (!active) return;
        if (current.status === "completed") {
          const resultError = validatePdfResult(current.result);
          if (!resultError) {
            const replacedJobId = saveReplacementJobIdRef.current;
            retainedJobIdRef.current = current.id;
            // Older installed agents ignore replaceJobId and would otherwise
            // leave the previous retained result in Results. The current
            // agent also accepts this cleanup safely after native replacement.
            if (replacedJobId) deleteProcessingJob("local", replacedJobId).catch(() => undefined);
          }
          saveReplacementJobIdRef.current = "";
          setSaveJob(null);
          setSaveNotice(resultError
            ? { type: "error", message: `The PDF could not be saved: ${resultError}` }
            : { type: "success", message: `Saved “${current.result.filename}” to the Local agent Results folder.` });
          return;
        }
        if (current.status === "failed") {
          setSaveJob(null);
          setSaveNotice({ type: "error", message: current.error || "The PDF could not be saved to this device." });
          return;
        }
        setSaveJob(current);
        timer = window.setTimeout(poll, 1000);
      } catch (error) {
        if (!active) return;
        setSaveJob(null);
        setSaveNotice({ type: "error", message: error instanceof Error ? error.message : "Unable to verify the saved PDF." });
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [saveJob?.id]);

  const defaultResultFilename = useMemo(() => {
    if (pdfFiles.length === 1) return `${filenameStem(pdfFiles[0]?.name)}_edited.pdf`;
    return pdfFiles.length > 1 ? "merged_edited.pdf" : "blank_pages_edited.pdf";
  }, [pdfFiles]);

  useEffect(() => {
    if (!resultFilenameTouchedRef.current) setResultFilenameStem(filenameStem(defaultResultFilename));
  }, [defaultResultFilename]);

  useEffect(() => {
    if (!moreToolsOpen) return undefined;
    const closeOnOutsidePointer = (event) => {
      if (!moreToolsRef.current?.contains(event.target)) setMoreToolsOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setMoreToolsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [moreToolsOpen]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 680px)");
    const update = () => setMobileLayout(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => () => {
    for (const url of imageUrlsRef.current) URL.revokeObjectURL(url);
    if (dropAnimationTimerRef.current) window.clearTimeout(dropAnimationTimerRef.current);
    if (dragScrollFrameRef.current) window.cancelAnimationFrame(dragScrollFrameRef.current);
    if (suppressPageClickTimerRef.current) window.clearTimeout(suppressPageClickTimerRef.current);
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
  }, []);

  const selectedPage = useMemo(() => pages.find((page) => page.id === selectedId) || pages[0] || null, [pages, selectedId]);
  const selectedPageImages = useMemo(() => getPageImages(selectedPage), [selectedPage]);

  const notifyHistoryChange = () => setHistoryRevision((current) => current + 1);

  const pushHistorySnapshot = (snapshot) => {
    const history = historyRef.current;
    const previous = history.past.at(-1);
    if (previous?.pages === snapshot.pages && previous?.pdfFiles === snapshot.pdfFiles) return;
    history.past.push(snapshot);
    if (history.past.length > 100) history.past.shift();
    history.future = [];
    notifyHistoryChange();
  };

  const flushPendingHistory = () => {
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
    historyTimerRef.current = null;
    const pending = pendingHistoryRef.current;
    pendingHistoryRef.current = null;
    if (pending && (pending.pages !== pagesRef.current || pending.pdfFiles !== pdfFilesRef.current)) pushHistorySnapshot(pending);
  };

  const schedulePendingHistoryFlush = () => {
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
    historyTimerRef.current = window.setTimeout(() => {
      historyTimerRef.current = null;
      flushPendingHistory();
    }, 350);
  };

  const clearDocumentHistory = () => {
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
    historyTimerRef.current = null;
    pendingHistoryRef.current = null;
    historyRef.current = { past: [], future: [] };
    notifyHistoryChange();
  };

  const commitDocument = (nextPages, nextPdfFiles = pdfFilesRef.current, { history = "discrete" } = {}) => {
    const currentPages = pagesRef.current;
    const currentPdfFiles = pdfFilesRef.current;
    if (nextPages === currentPages && nextPdfFiles === currentPdfFiles) return false;
    setSaveNotice(null);
    if (history === "coalesce") {
      if (!pendingHistoryRef.current) {
        pendingHistoryRef.current = { pages: currentPages, pdfFiles: currentPdfFiles };
        historyRef.current.future = [];
        notifyHistoryChange();
      }
      schedulePendingHistoryFlush();
    } else if (history === "discrete") {
      flushPendingHistory();
      pushHistorySnapshot({ pages: currentPages, pdfFiles: currentPdfFiles });
    }
    pagesRef.current = nextPages;
    pdfFilesRef.current = nextPdfFiles;
    setPages(nextPages);
    if (nextPdfFiles !== currentPdfFiles) setPdfFiles(nextPdfFiles);
    return true;
  };

  const restoreDocumentSnapshot = (snapshot) => {
    pagesRef.current = snapshot.pages;
    pdfFilesRef.current = snapshot.pdfFiles;
    setPages(snapshot.pages);
    setPdfFiles(snapshot.pdfFiles);
    setSelectedId((current) => snapshot.pages.some((page) => page.id === current) ? current : snapshot.pages[0]?.id || null);
  };

  const undoDocument = () => {
    flushPendingHistory();
    const history = historyRef.current;
    const snapshot = history.past.pop();
    if (!snapshot) return;
    history.future.push({ pages: pagesRef.current, pdfFiles: pdfFilesRef.current });
    restoreDocumentSnapshot(snapshot);
    notifyHistoryChange();
    setError("");
  };

  const redoDocument = () => {
    flushPendingHistory();
    const history = historyRef.current;
    const snapshot = history.future.pop();
    if (!snapshot) return;
    history.past.push({ pages: pagesRef.current, pdfFiles: pdfFilesRef.current });
    if (history.past.length > 100) history.past.shift();
    restoreDocumentSnapshot(snapshot);
    notifyHistoryChange();
    setError("");
  };

  const canUndo = Boolean(pendingHistoryRef.current) || historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0 && !pendingHistoryRef.current;

  useEffect(() => {
    if (!selectedPage && !canUndo && !canRedo) setMoreToolsOpen(false);
  }, [canRedo, canUndo, selectedPage]);

  const changePreviewZoom = (delta) => setPreviewZoom((current) => Math.min(3, Math.max(0.6, Math.round((current + delta) * 10) / 10)));
  const resetPreviewZoom = () => setPreviewZoom(1);

  const rotateSelectedPage = (delta) => {
    if (!selectedPage) return;
    updatePage(selectedPage.id, { rotation: normalizeRotation((selectedPage.rotation || 0) + delta) });
    setError("");
  };

  const duplicateSelectedPage = async () => {
    if (!selectedPage) return;
    if (processingMode === "browser") {
      setError(BROWSER_DUPLICATE_PAGE_ERROR);
      return;
    }
    const clonedImages = await Promise.all(getPageImages(selectedPage).map(async (image) => {
      const clone = { ...image, id: makeId() };
      if (image.file) {
        clone.url = URL.createObjectURL(image.file);
        imageUrlsRef.current.add(clone.url);
      } else if (image.sourceBytes) {
        clone.url = URL.createObjectURL(new Blob([image.sourceBytes], { type: image.file?.type || "image/png" }));
        imageUrlsRef.current.add(clone.url);
      } else if (image.url) {
        try {
          const response = await fetch(image.url);
          if (response.ok) {
            clone.url = URL.createObjectURL(await response.blob());
            imageUrlsRef.current.add(clone.url);
          }
        } catch {
          clone.url = image.url;
        }
      }
      return clone;
    }));
    const duplicate = { ...selectedPage, id: makeId(), images: clonedImages, textBoxes: getPageTextBoxes(selectedPage).map((textBox) => ({ ...textBox, id: makeId() })) };
    const selectedIndex = pagesRef.current.findIndex((page) => page.id === selectedPage.id);
    const next = [...pagesRef.current];
    next.splice(selectedIndex >= 0 ? selectedIndex + 1 : next.length, 0, duplicate);
    commitDocument(next);
    setSelectedId(duplicate.id);
    setError("");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      scrollPreviewIntoView(duplicate.id);
      scrollThumbnailIntoView(duplicate.id);
    }));
  };

  const addPdfFiles = async (candidates) => {
    const selectedFiles = Array.from(candidates || []);
    if (!selectedFiles.length) return;
    setError("");
    setPreviewError("");
    if (pdfFiles.length + selectedFiles.length > MAX_PDF_COUNT) { setError(`You can add up to ${MAX_PDF_COUNT} PDFs.`); return; }
    for (const file of selectedFiles) {
      if (!isPdf(file)) { setError(`${file.name} is not a PDF.`); return; }
    }
    const existingPdfBytes = pdfFiles.reduce((total, record) => total + Number(record.file?.size || 0), 0);
    const selectedPdfBytes = selectedFiles.reduce((total, file) => total + Number(file.size || 0), 0);
    const pdfTotalLimit = processingMode === "browser" ? BROWSER_PDF_EDITOR_MAX_TOTAL_BYTES : MAX_PDF_TOTAL_BYTES;
    if (existingPdfBytes + selectedPdfBytes > pdfTotalLimit) {
      setError(processingMode === "browser" ? "Browser mode accepts PDFs up to 50 MB total. Use Local agent for larger projects." : "The combined PDF upload must be 200 MB or smaller. Remove a PDF before adding another.");
      return;
    }

    setLoadingFiles(true);
    try {
      // File selection can happen before the initial PDF.js import finishes.
      // Wait for the same cached promise here so a valid PDF is not permanently
      // downgraded to the non-rendering pdf-lib fallback.
      let activePdfLibrary = pdfLibrary;
      if (!activePdfLibrary) {
        try {
          activePdfLibrary = await ensurePdfLibrary();
          setPdfLibrary(activePdfLibrary);
        } catch (libraryError) {
          if (processingMode === "browser") throw libraryError;
        }
      }
      let pdfIndex = pdfFilesRef.current.length;
      const newFiles = [];
      const newPages = [];
      let thumbnailFailures = 0;
      let browserFallbacks = 0;
      let serverFallbacks = 0;
      let passwordProtectedFiles = 0;
      for (const file of selectedFiles) {
      const loaded = await loadPdfFile(file, activePdfLibrary, { allowServerFallback: processingMode === "server", browserOnly: processingMode === "browser" });
      if (processingMode === "browser" && !loaded.documentProxy) throw new Error("This PDF could not be rendered in Browser mode. Switch to Local agent for this file.");
      if (processingMode === "browser" && loaded.passwordProtected) throw new Error(BROWSER_PASSWORD_PDF_ERROR);
      const pdfDocument = loaded.documentProxy;
        documentsRef.current[pdfIndex] = pdfDocument;
        if (loaded.fallbackDocument) browserFallbacks += 1;
        if (loaded.serverFallback) serverFallbacks += 1;
        if (loaded.passwordProtected) passwordProtectedFiles += 1;
        const fileRecord = { id: makeId(), file, name: file.name, pageCount: loaded.pageCount, sourceBytes: loaded.data };
        newFiles.push(fileRecord);
        for (let pageNumber = 1; pageNumber <= loaded.pageCount; pageNumber += 1) {
          let thumbnail;
          let sourcePdfPage = null;
          if (loaded.fallbackDocument || loaded.serverFallback) {
            const size = loaded.fallbackDocument?.getPages()[pageNumber - 1]?.getSize() || loaded.pageSizes?.[pageNumber - 1] || A4;
            thumbnail = { thumbnail: loaded.previewToken ? `/api/pdf/preview?token=${encodeURIComponent(loaded.previewToken)}&page=${pageNumber}&thumbnail=1` : fallbackThumbnail(`Page ${pageNumber}`), width: size.width, height: size.height, rotation: size.rotation || 0, previewFallback: true };
          } else try {
            const pdfPage = await pdfDocument.getPage(pageNumber);
            sourcePdfPage = pdfPage;
            const dimensions = pageDimensions(pdfPage);
            thumbnail = { thumbnail: null, ...dimensions };
          } catch (thumbnailError) {
            thumbnailFailures += 1;
            const dimensions = thumbnailError?.pageDimensions || A4;
            thumbnail = { thumbnail: fallbackThumbnail(`Page ${pageNumber}`), width: dimensions.width, height: dimensions.height, rotation: dimensions.rotation || 0, previewFallback: true };
          }
          newPages.push({ id: makeId(), kind: loaded.passwordProtected ? "raster" : "source", pdfIndex, pageIndex: pageNumber - 1, sourceName: file.name, pageNumber, previewToken: loaded.previewToken || null, pdfPage: sourcePdfPage, ...thumbnail });
        }
        pdfIndex += 1;
      }
      const nextPdfFiles = [...pdfFilesRef.current, ...newFiles];
      const nextPages = [...pagesRef.current, ...newPages];
      commitDocument(nextPages, nextPdfFiles);
      pushAnalyticsEvent("input_selected", { tool: "pdf-editor", input_type: "pdf", count: newFiles.length });
      if (!selectedId && nextPages[0]) setSelectedId(nextPages[0].id);
      if (browserFallbacks || serverFallbacks || thumbnailFailures || passwordProtectedFiles) {
        const messages = [];
        if (browserFallbacks) messages.push("PDF preview was unavailable, so a safe PDF parser was used");
        if (serverFallbacks) messages.push("The Local agent PDF reader was used to validate the document");
        if (thumbnailFailures) messages.push(`${thumbnailFailures} page preview${thumbnailFailures === 1 ? "" : "s"} could not be rendered`);
        if (passwordProtectedFiles) messages.push(`${passwordProtectedFiles} password-protected PDF${passwordProtectedFiles === 1 ? " was" : "s were"} opened with the supplied password and will be safely flattened during export`);
        setPreviewError(`${messages.join("; ")}. The PDF can still be edited and exported.`);
      }
    } catch (loadError) {
      const detail = loadError instanceof Error ? loadError.message : "";
      console.error("PDF editor import failed", loadError);
      setError(/password|encrypt/i.test(detail) ? "The PDF could not be opened. Check the password and try again." : detail ? `PDF import failed: ${detail.slice(0, 240)}` : "The browser and Local agent PDF readers could not open this file.");
    } finally {
      setLoadingFiles(false);
    }
  };

  const openPdfPicker = () => {
    pdfInputRef.current?.click();
  };

  useEffect(() => {
    if (!continuingFile || loadingFiles || pdfFiles.length || pages.length || job) return;
    const file = continuingFile;
    setContinuingFile(null);
    addPdfFiles([file]);
  }, [continuingFile, loadingFiles, pdfFiles.length, pages.length, job, pdfLibrary]);

  useEffect(() => {
    if (historyEditLoadedRef.current) return;
    historyEditLoadedRef.current = true;
    const pending = takeHistoryEdit("pdf-editor");
    if (!pending?.downloadUrl) return undefined;
    let active = true;
    fetch(pending.downloadUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("The saved PDF could not be reopened.");
      const blob = await response.blob();
      if (active) {
        retainedJobIdRef.current = pending.retainedJobId || null;
        setContinuingFile(new File([blob], pending.filename || "saved.pdf", { type: "application/pdf" }));
      }
    }).catch((loadError) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "The saved PDF could not be reopened.");
    });
    return () => { active = false; };
  }, []);

  const handlePdfDragOver = (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setPdfDragActive(true);
  };

  const handlePdfDragLeave = (event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setPdfDragActive(false);
  };

  const handlePdfDrop = (event) => {
    event.preventDefault();
    setPdfDragActive(false);
    const droppedFiles = Array.from(event.dataTransfer?.files || []);
    if (processingMode === "browser" && droppedFiles.length && !droppedFiles.some((file) => isPdf(file))) {
      void addImages(droppedFiles, selectedPage?.id);
      return;
    }
    addPdfFiles(droppedFiles);
  };

  const updatePage = (pageId, changes, history = "discrete") => commitDocument(pagesRef.current.map((page) => page.id === pageId ? { ...page, ...changes } : page), pdfFilesRef.current, { history });

  const addBlankPage = () => {
    const dimensions = selectedPage ? { width: selectedPage.width, height: selectedPage.height, rotation: selectedPage.rotation || 0 } : A4;
    const page = { id: makeId(), kind: "blank", ...dimensions, images: [], textBoxes: [] };
    const selectedIndex = selectedPage ? pagesRef.current.findIndex((item) => item.id === selectedPage.id) : -1;
    const next = [...pagesRef.current];
    next.splice(selectedIndex >= 0 ? selectedIndex + 1 : next.length, 0, page);
    commitDocument(next);
    setSelectedId(page.id);
    setError("");
  };

  const addBlankPageAfter = (previousPageId) => {
    const previousPage = pages.find((item) => item.id === previousPageId);
    const dimensions = previousPage ? { width: previousPage.width, height: previousPage.height, rotation: previousPage.rotation || 0 } : A4;
    const page = { id: makeId(), kind: "blank", ...dimensions, images: [], textBoxes: [] };
    const previousIndex = pagesRef.current.findIndex((item) => item.id === previousPageId);
    const next = [...pagesRef.current];
    next.splice(previousIndex >= 0 ? previousIndex + 1 : next.length, 0, page);
    commitDocument(next);
    setSelectedId(page.id);
    setError("");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      scrollPreviewIntoView(page.id);
      scrollThumbnailIntoView(page.id);
    }));
  };

  const deletePage = (pageId) => {
    const current = pagesRef.current;
    const index = current.findIndex((page) => page.id === pageId);
    if (index === -1) return;
    const next = current.filter((page) => page.id !== pageId);
    commitDocument(next);
    if (pageId === selectedId) setSelectedId(next[Math.min(index, next.length - 1)]?.id || null);
  };

  const reorderPages = (sourceId, targetId, position = "before") => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const beforeRects = new Map();
    for (const [pageId, element] of pageElementRefs.current.entries()) beforeRects.set(pageId, element.getBoundingClientRect());
    const current = pagesRef.current;
    const sourceIndex = current.findIndex((page) => page.id === sourceId);
    const targetIndex = current.findIndex((page) => page.id === targetId);
    if (sourceIndex === -1 || targetIndex === -1) return;
    const next = [...current];
    const [moved] = next.splice(sourceIndex, 1);
    let insertionIndex = targetIndex + (position === "after" ? 1 : 0);
    if (sourceIndex < insertionIndex) insertionIndex -= 1;
    next.splice(insertionIndex, 0, moved);
    commitDocument(next);
    setSelectedId(sourceId);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => scrollPreviewIntoView(sourceId)));
    setDropTargetId(null);
    setDropPosition(null);
    setRecentlyDroppedId(sourceId);
    if (dropAnimationTimerRef.current) window.clearTimeout(dropAnimationTimerRef.current);
    dropAnimationTimerRef.current = window.setTimeout(() => setRecentlyDroppedId(null), 1100);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      for (const [pageId, element] of pageElementRefs.current.entries()) {
        const before = beforeRects.get(pageId);
        if (!before || !element.isConnected) continue;
        const after = element.getBoundingClientRect();
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        element.animate([
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0, 0)" },
        ], { duration: 1050, easing: "cubic-bezier(.2, .8, .2, 1)" });
      }
    }));
  };

  const clearDropIntent = () => {
    dropIntentRef.current = { targetId: null, position: null };
    setDropTargetId(null);
    setDropPosition(null);
  };

  const stopPageListAutoScroll = () => {
    if (dragScrollFrameRef.current) window.cancelAnimationFrame(dragScrollFrameRef.current);
    dragScrollFrameRef.current = null;
  };

  const startPageListAutoScroll = () => {
    if (dragScrollFrameRef.current || !draggedIdRef.current) return;
    const tick = () => {
      dragScrollFrameRef.current = null;
      const list = pageListRef.current;
      if (!list || !draggedIdRef.current) return;
      const bounds = list.getBoundingClientRect();
      const { x, y, forceBottom, forceRight, valid } = dragPointerRef.current;
      const edge = 116;
      let moved = false;
      if (valid && list.scrollHeight > list.clientHeight) {
        if (y < bounds.top + edge) {
          const intensity = Math.min(1, (bounds.top + edge - y) / edge);
          const previousScrollTop = list.scrollTop;
          list.scrollTop -= Math.max(7, Math.round(8 + intensity * 24));
          moved = moved || list.scrollTop !== previousScrollTop;
        } else if (forceBottom || y > bounds.bottom - edge) {
          const intensity = forceBottom ? 1 : Math.min(1, (y - (bounds.bottom - edge)) / edge);
          const previousScrollTop = list.scrollTop;
          list.scrollTop += Math.max(7, Math.round(8 + intensity * 24));
          moved = moved || list.scrollTop !== previousScrollTop;
        }
      }
      if (valid && list.scrollWidth > list.clientWidth) {
        if (x < bounds.left + edge) {
          const intensity = Math.min(1, (bounds.left + edge - x) / edge);
          const previousScrollLeft = list.scrollLeft;
          list.scrollLeft -= Math.max(7, Math.round(8 + intensity * 24));
          moved = moved || list.scrollLeft !== previousScrollLeft;
        } else if (forceRight || x > bounds.right - edge) {
          const intensity = forceRight ? 1 : Math.min(1, (x - (bounds.right - edge)) / edge);
          const previousScrollLeft = list.scrollLeft;
          list.scrollLeft += Math.max(7, Math.round(8 + intensity * 24));
          moved = moved || list.scrollLeft !== previousScrollLeft;
        }
      }
      if (moved && pointerPageDragRef.current?.active) updatePointerPageDrop({ clientX: x, clientY: y }, { startAutoScroll: false });
      // Keep the loop alive while a drag is active. Some mobile browsers stop
      // emitting dragover once the pointer sits at a scroll edge, so relying on
      // movement or another event here leaves the horizontal rail stuck.
      if (draggedIdRef.current && valid) dragScrollFrameRef.current = window.requestAnimationFrame(tick);
    };
    dragScrollFrameRef.current = window.requestAnimationFrame(tick);
  };

  const handlePageListDragOver = (event) => {
    event.preventDefault();
    if (!draggedIdRef.current) return;
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX !== 0 || event.clientY !== 0)) dragPointerRef.current = { ...dragPointerRef.current, x: event.clientX, y: event.clientY, valid: true };
    startPageListAutoScroll();
  };

  const handlePageDrag = (event) => {
    if (!draggedIdRef.current) return;
    // On the mobile horizontal rail, dragover can stop firing once the
    // pointer reaches the edge of the scrollable list. The drag source still
    // emits drag events, so keep the auto-scroll pointer position fresh here.
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX !== 0 || event.clientY !== 0)) dragPointerRef.current = { ...dragPointerRef.current, x: event.clientX, y: event.clientY, valid: true };
    startPageListAutoScroll();
  };

  const pageDropPosition = (event, element) => {
    const bounds = element?.getBoundingClientRect?.();
    if (!bounds) return null;
    const list = pageListRef.current;
    const horizontal = Boolean(list && list.scrollWidth > list.clientWidth + 1 && list.scrollHeight <= list.clientHeight + 1);
    return horizontal
      ? (event.clientX < bounds.left + bounds.width / 2 ? "before" : "after")
      : (event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
  };

  const pageListIsHorizontal = () => {
    const list = pageListRef.current;
    return Boolean(list && list.scrollWidth > list.clientWidth + 1 && list.scrollHeight <= list.clientHeight + 1);
  };

  const findPageAtPointer = (x, y, sourceId) => {
    const list = pageListRef.current;
    if (!list) return null;
    const bounds = list.getBoundingClientRect();
    const visible = [...pageElementRefs.current.entries()]
      .filter(([pageId, element]) => {
        if (pageId === sourceId) return false;
        const pageBounds = element.getBoundingClientRect();
        return pageBounds.bottom > bounds.top && pageBounds.top < bounds.bottom && pageBounds.right > bounds.left && pageBounds.left < bounds.right;
      })
      .map(([pageId, element]) => ({ pageId, element, bounds: element.getBoundingClientRect() }));
    if (!visible.length) return null;
    const pointed = visible.find(({ bounds: pageBounds }) => x >= pageBounds.left && x <= pageBounds.right && y >= pageBounds.top && y <= pageBounds.bottom);
    if (pointed) return pointed;
    const horizontal = pageListIsHorizontal();
    const coordinate = horizontal ? x : y;
    const start = horizontal ? bounds.left : bounds.top;
    const end = horizontal ? bounds.right : bounds.bottom;
    const ordered = visible.sort((left, right) => (horizontal ? left.bounds.left - right.bounds.left : left.bounds.top - right.bounds.top));
    if (coordinate <= start) return ordered[0];
    if (coordinate >= end) return ordered.at(-1);
    return ordered.reduce((closest, candidate) => {
      const closestCenter = horizontal ? (closest.bounds.left + closest.bounds.right) / 2 : (closest.bounds.top + closest.bounds.bottom) / 2;
      const candidateCenter = horizontal ? (candidate.bounds.left + candidate.bounds.right) / 2 : (candidate.bounds.top + candidate.bounds.bottom) / 2;
      return Math.abs(candidateCenter - coordinate) < Math.abs(closestCenter - coordinate) ? candidate : closest;
    });
  };

  const setSuppressedPageClick = () => {
    suppressPageClickRef.current = true;
    if (suppressPageClickTimerRef.current) window.clearTimeout(suppressPageClickTimerRef.current);
    suppressPageClickTimerRef.current = window.setTimeout(() => {
      suppressPageClickRef.current = false;
      suppressPageClickTimerRef.current = null;
    }, 300);
  };

  const updatePointerPageDrop = (event, { startAutoScroll = true } = {}) => {
    const drag = pointerPageDragRef.current;
    if (!drag?.active || !draggedIdRef.current) return;
    dragPointerRef.current = { ...dragPointerRef.current, x: event.clientX, y: event.clientY, forceBottom: false, forceRight: false, valid: true };
    if (startAutoScroll) startPageListAutoScroll();
    const target = findPageAtPointer(event.clientX, event.clientY, drag.pageId);
    if (!target) {
      clearDropIntent();
      return;
    }
    const position = pageDropPosition(event, target.element);
    const sourceIndex = pages.findIndex((page) => page.id === drag.pageId);
    const targetIndex = pages.findIndex((page) => page.id === target.pageId);
    const noChange = sourceIndex === targetIndex || (position === "before" && sourceIndex + 1 === targetIndex) || (position === "after" && sourceIndex - 1 === targetIndex);
    if (sourceIndex === -1 || targetIndex === -1 || noChange) {
      clearDropIntent();
      return;
    }
    dropIntentRef.current = { targetId: target.pageId, position };
    setDropTargetId(target.pageId);
    setDropPosition(position);
  };

  const handlePageListPointerDown = (event) => {
    if ((!mobileLayout && event.pointerType === "mouse") || !event.isPrimary || (event.button !== undefined && event.button !== 0) || event.target.closest?.(".thumbnail-drag-handle")) return;
    pointerPageScrollRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, moved: false };
  };

  const handlePageListPointerMove = (event) => {
    const scroll = pointerPageScrollRef.current;
    if (!scroll || scroll.pointerId !== event.pointerId || pointerPageDragRef.current) return;
    const totalX = event.clientX - scroll.startX;
    const totalY = event.clientY - scroll.startY;
    if (!scroll.moved) {
      if (Math.hypot(totalX, totalY) < 8 || Math.abs(totalY) > Math.abs(totalX)) return;
      scroll.moved = true;
      setSuppressedPageClick();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    const list = pageListRef.current;
    if (!list) return;
    event.preventDefault();
    list.scrollLeft -= event.clientX - scroll.lastX;
    scroll.lastX = event.clientX;
  };

  const finishPageListPointerScroll = (event) => {
    const scroll = pointerPageScrollRef.current;
    if (!scroll || scroll.pointerId !== event.pointerId) return;
    pointerPageScrollRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handlePageListWheel = (event) => {
    const list = pageListRef.current;
    if (!list || list.scrollWidth <= list.clientWidth + 1) return;
    const delta = event.shiftKey ? (event.deltaY || event.deltaX) : Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : 0;
    if (!delta) return;
    event.preventDefault();
    list.scrollLeft += delta;
  };

  const handlePagePointerDown = (event, pageId) => {
    if ((!mobileLayout && event.pointerType === "mouse") || !event.isPrimary || (event.button !== undefined && event.button !== 0) || !event.target.closest?.(".thumbnail-drag-handle")) return;
    if (suppressPageClickRef.current) suppressPageClickRef.current = false;
    pointerPageDragRef.current = { pageId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false, element: event.currentTarget };
  };

  const handlePagePointerMove = (event) => {
    const drag = pointerPageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 8) return;
      drag.active = true;
      setSuppressedPageClick();
      draggedIdRef.current = drag.pageId;
      dragPointerRef.current = { x: event.clientX, y: event.clientY, forceBottom: false, forceRight: false, valid: true };
      dropIntentRef.current = { targetId: null, position: null };
      setDraggedId(drag.pageId);
      setDropTargetId(null);
      setDropPosition(null);
      drag.element.setPointerCapture?.(event.pointerId);
    }
    event.preventDefault();
    updatePointerPageDrop(event);
  };

  const finishPagePointerDrag = (event, cancelled = false) => {
    const drag = pointerPageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerPageDragRef.current = null;
    drag.element.releasePointerCapture?.(event.pointerId);
    if (!drag.active) return;
    event.preventDefault();
    const { targetId, position } = dropIntentRef.current;
    const sourceIndex = pages.findIndex((page) => page.id === drag.pageId);
    const targetIndex = pages.findIndex((page) => page.id === targetId);
    const noChange = sourceIndex === targetIndex || (position === "before" && sourceIndex + 1 === targetIndex) || (position === "after" && sourceIndex - 1 === targetIndex);
    if (!cancelled && targetId && position && sourceIndex !== -1 && targetIndex !== -1 && !noChange) reorderPages(drag.pageId, targetId, position);
    resetDragState();
  };

  const handlePageDragOver = (event, pageId) => {
    event.preventDefault();
    const activeDraggedId = draggedIdRef.current || draggedId;
    if (!activeDraggedId) return;
    const list = pageListRef.current;
    const targetBounds = event.currentTarget.getBoundingClientRect();
    let forceBottom = false;
    let forceRight = false;
    if (list) {
      const bounds = list.getBoundingClientRect();
      const visiblePages = [...pageElementRefs.current.entries()].filter(([, element]) => {
        const pageBounds = element.getBoundingClientRect();
        return pageBounds.bottom > bounds.top && pageBounds.top < bounds.bottom && pageBounds.right > bounds.left && pageBounds.left < bounds.right;
      });
      const lastVisible = visiblePages.sort((left, right) => right[1].getBoundingClientRect().bottom - left[1].getBoundingClientRect().bottom)[0];
      const rightmostVisible = visiblePages.sort((left, right) => right[1].getBoundingClientRect().right - left[1].getBoundingClientRect().right)[0];
      forceBottom = Boolean(lastVisible && lastVisible[0] === pageId && targetBounds.bottom >= bounds.bottom - 48 && event.clientY >= targetBounds.top + targetBounds.height * 0.3);
      forceRight = Boolean(rightmostVisible && rightmostVisible[0] === pageId && targetBounds.right >= bounds.right - 48 && event.clientX >= targetBounds.left + targetBounds.width * 0.3);
    }
    const pointerValid = Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX !== 0 || event.clientY !== 0);
    dragPointerRef.current = { ...dragPointerRef.current, x: event.clientX, y: event.clientY, forceBottom, forceRight, valid: pointerValid || dragPointerRef.current.valid };
    startPageListAutoScroll();
    if (activeDraggedId === pageId) {
      clearDropIntent();
      return;
    }
    const position = pageDropPosition(event, event.currentTarget);
    const sourceIndex = pages.findIndex((page) => page.id === activeDraggedId);
    const targetIndex = pages.findIndex((page) => page.id === pageId);
    const noChange = sourceIndex === targetIndex || (position === "before" && sourceIndex + 1 === targetIndex) || (position === "after" && sourceIndex - 1 === targetIndex);
    if (sourceIndex === -1 || targetIndex === -1 || noChange) {
      clearDropIntent();
      return;
    }
    dropIntentRef.current = { targetId: pageId, position };
    setDropTargetId(pageId);
    setDropPosition(position);
  };

  const handlePageDrop = (event, pageId) => {
    event.preventDefault();
    stopPageListAutoScroll();
    const activeDraggedId = draggedIdRef.current || draggedId;
    const pointerPosition = pageDropPosition(event, event.currentTarget);
    const position = pointerPosition || dropIntentRef.current.position;
    if (!activeDraggedId || !pageId || !position) {
      clearDropIntent();
      return;
    }
    const sourceIndex = pages.findIndex((page) => page.id === activeDraggedId);
    const targetIndex = pages.findIndex((page) => page.id === pageId);
    const noChange = sourceIndex === targetIndex || (position === "before" && sourceIndex + 1 === targetIndex) || (position === "after" && sourceIndex - 1 === targetIndex);
    if (sourceIndex === -1 || targetIndex === -1 || noChange) {
      clearDropIntent();
      return;
    }
    reorderPages(activeDraggedId, pageId, position);
  };

  const handlePageListDrop = (event) => {
    event.preventDefault();
    stopPageListAutoScroll();
    const { targetId, position } = dropIntentRef.current;
    const activeDraggedId = draggedIdRef.current || draggedId;
    if (!activeDraggedId || !targetId || !position) {
      clearDropIntent();
      return;
    }
    reorderPages(activeDraggedId, targetId, position);
  };

  const startDraggingPage = (pageId, event) => {
    draggedIdRef.current = pageId;
    dragPointerRef.current = { x: event?.clientX || 0, y: event?.clientY || 0, forceBottom: false, forceRight: false, valid: Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY) && (event.clientX !== 0 || event.clientY !== 0) };
    dropIntentRef.current = { targetId: null, position: null };
    setDraggedId(pageId);
    setDropTargetId(null);
    setDropPosition(null);
  };

  const resetDragState = () => {
    stopPageListAutoScroll();
    draggedIdRef.current = null;
    dragPointerRef.current = { ...dragPointerRef.current, valid: false, forceBottom: false, forceRight: false };
    clearDropIntent();
    setDraggedId(null);
  };

  const renderPageList = () => {
    return pages.map((page, index) => <PdfPageThumbnail key={page.id} page={page} index={index} elementRef={(element) => { if (element) pageElementRefs.current.set(page.id, element); else pageElementRefs.current.delete(page.id); }} thumbnailRootRef={pageListRef} pdfDocument={page.kind === "source" ? documentsRef.current[page.pdfIndex] : null} nativeDraggable={!mobileLayout} onThumbnailError={() => setPreviewError("Some thumbnails could not be rendered, but the pages remain available in the full preview.")} selected={page.id === selectedPage?.id} draggedId={draggedId} dropTargetId={dropTargetId} dropPosition={dropPosition} recentlyDroppedId={recentlyDroppedId} onSelect={() => { if (suppressPageClickRef.current) { suppressPageClickRef.current = false; return; } selectPage(page.id); }} onKeyDown={(event) => handleThumbnailKeyDown(event, page.id)} onDelete={() => deletePage(page.id)} onDragStart={(event) => startDraggingPage(page.id, event)} onDrag={handlePageDrag} onDragEnd={resetDragState} onDragOver={(event) => handlePageDragOver(event, page.id)} onDrop={(event) => handlePageDrop(event, page.id)} onPointerDown={(event) => handlePagePointerDown(event, page.id)} onPointerMove={handlePagePointerMove} onPointerUp={finishPagePointerDrag} onPointerCancel={(event) => finishPagePointerDrag(event, true)} />);
  };

  const scrollThumbnailIntoView = (pageId) => {
    const list = pageListRef.current;
    const element = pageElementRefs.current.get(pageId);
    if (!list || !element) return;
    if (list.scrollHeight > list.clientHeight) {
      const top = element.offsetTop - list.clientHeight * 0.35;
      list.scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, top));
    }
    if (list.scrollWidth > list.clientWidth) {
      const left = element.offsetLeft - list.clientWidth * 0.35;
      list.scrollLeft = Math.max(0, Math.min(list.scrollWidth - list.clientWidth, left));
    }
  };

  const scrollPreviewIntoView = (pageId) => {
    const container = previewScrollRef.current;
    const element = previewElementRefs.current.get(pageId);
    if (!container || !element) return;
    const containerBounds = container.getBoundingClientRect();
    const elementBounds = element.getBoundingClientRect();
    const targetTop = container.scrollTop + elementBounds.top - containerBounds.top - Math.max(0, (container.clientHeight - elementBounds.height) / 2);
    container.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  };

  const selectPage = (pageId, { scrollThumbnail = true } = {}) => {
    setSelectedId(pageId);
    if (scrollThumbnail) scrollThumbnailIntoView(pageId);
    window.requestAnimationFrame(() => scrollPreviewIntoView(pageId));
  };

  const handleThumbnailKeyDown = (event, pageId) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    const currentIndex = pagesRef.current.findIndex((page) => page.id === pageId);
    const nextIndex = currentIndex + (event.key === "ArrowUp" ? -1 : 1);
    const nextPage = pagesRef.current[nextIndex];
    if (!nextPage) return;
    keyboardThumbnailTargetRef.current = nextPage.id;
    window.setTimeout(() => {
      if (keyboardThumbnailTargetRef.current === nextPage.id) keyboardThumbnailTargetRef.current = null;
    }, 1000);
    selectPage(nextPage.id, { scrollThumbnail: false });
    window.requestAnimationFrame(() => {
      const target = pageElementRefs.current.get(nextPage.id);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  };

  const handlePreviewScroll = () => {
    const container = previewScrollRef.current;
    if (!container || !pages.length) return;
    const containerBounds = container.getBoundingClientRect();
    const center = containerBounds.top + container.clientHeight / 2;
    let bestPage = null;
    let bestDistance = Infinity;
    for (const page of pages) {
      const element = previewElementRefs.current.get(page.id);
      if (!element) continue;
      const bounds = element.getBoundingClientRect();
      const visible = Math.min(containerBounds.bottom, bounds.bottom) - Math.max(containerBounds.top, bounds.top);
      if (visible <= 0) continue;
      const distance = Math.abs((bounds.top + bounds.bottom) / 2 - center);
      if (distance < bestDistance) {
        bestPage = page;
        bestDistance = distance;
      }
    }
    const keyboardTargetId = keyboardThumbnailTargetRef.current;
    if (keyboardTargetId) {
      if (bestPage?.id === keyboardTargetId) {
        if (bestPage.id !== selectedId) setSelectedId(bestPage.id);
        window.requestAnimationFrame(() => {
          if (keyboardThumbnailTargetRef.current !== keyboardTargetId) return;
          pageElementRefs.current.get(keyboardTargetId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
          keyboardThumbnailTargetRef.current = null;
        });
      }
      return;
    }
    if (bestPage && bestPage.id !== selectedId) {
      setSelectedId(bestPage.id);
      window.requestAnimationFrame(() => scrollThumbnailIntoView(bestPage.id));
    }
  };

  const addImages = async (fileList, targetPageId = selectedPage?.id) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    const targetPage = pagesRef.current.find((page) => page.id === targetPageId) || selectedPage;
    if (!targetPage) { setError("Select a PDF page before adding images."); return; }
    for (const file of files) {
      if (processingMode === "browser") {
        if (!isBrowserPdfEditorImage(file)) { setError(BROWSER_IMAGE_FORMAT_ERROR); return; }
        if (file.size > BROWSER_PDF_EDITOR_IMAGE_MAX_BYTES) { setError(BROWSER_IMAGE_SIZE_ERROR); return; }
      } else {
        if (!isImage(file)) { setError(`${file.name} is not a supported image. Choose PNG, JPG, JPEG, HEIC, TIFF, GIF, or BMP.`); return; }
        if (file.size > 25 * 1024 * 1024) { setError(`${file.name} is larger than the 25 MB image limit.`); return; }
      }
    }
    const addedImages = [];
    try {
      const existingImages = getPageImages(targetPage);
      for (const [index, file] of files.entries()) {
        const dimensions = await readImageSize(file);
        const maxWidth = targetPage.width * 0.86;
        const maxHeight = targetPage.height * 0.86;
        const scale = Math.min(maxWidth / dimensions.width, maxHeight / dimensions.height, 1);
        const width = dimensions.width * scale;
        const height = dimensions.height * scale;
        const offset = Math.min(72, (existingImages.length + index) * 18);
        const x = Math.max(0, Math.min(targetPage.width - width, (targetPage.width - width) / 2 + offset));
        const y = Math.max(0, Math.min(targetPage.height - height, (targetPage.height - height) / 2 + offset));
        const url = URL.createObjectURL(file);
        imageUrlsRef.current.add(url);
        addedImages.push({ id: makeId(), file, sourceBytes: await file.arrayBuffer(), url, x, y, width, height, rotation: 0, lockAspectRatio: true });
      }
      updatePage(targetPage.id, { images: [...existingImages, ...addedImages] });
      pushAnalyticsEvent("input_selected", { tool: "pdf-editor", input_type: "image", count: addedImages.length });
      setError("");
    } catch (imageError) {
      for (const image of addedImages) {
        URL.revokeObjectURL(image.url);
        imageUrlsRef.current.delete(image.url);
      }
      setError(imageError instanceof Error ? imageError.message : "The image could not be added.");
    }
  };

  const openImagePickerForPage = (pageId = selectedPage?.id) => {
    imageTargetPageIdRef.current = pageId || null;
    if (pageId) setSelectedId(pageId);
    imageInputRef.current?.click();
  };

  useEffect(() => {
    const handlePaste = (event) => {
      if (activeView !== "tool" || job || !selectedPage || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=\"true\"]")) return;
      const files = clipboardImageFiles(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      void addImages(files);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [activeView, job, selectedPage]);

  const removeImage = (pageId, imageId) => {
    const page = pagesRef.current.find((item) => item.id === pageId);
    const images = getPageImages(page);
    // Keep removed image URLs alive until the document history is cleared so
    // undo can restore the exact image without rebuilding its object URL.
    updatePage(pageId, { images: images.filter((item) => item.id !== imageId) });
  };

  const removeAllImages = (pageId) => {
    updatePage(pageId, { images: [] });
  };

  const addTextBox = () => {
    if (processingMode === "browser") {
      setError(BROWSER_TEXT_BOX_ERROR);
      return;
    }
    if (!selectedPage) {
      setError("Select a PDF page before adding a text box.");
      return;
    }
    const width = Math.min(280, Math.max(180, selectedPage.width * 0.55));
    const height = Math.min(86, Math.max(52, selectedPage.height * 0.12));
    const textBox = { id: makeId(), text: "", x: Math.max(0, (selectedPage.width - width) / 2), y: Math.max(0, (selectedPage.height - height) / 2), width, height, rotation: 0, fontSize: 18, fontFamily: "Helvetica", bold: false, italic: false, underline: false, color: "#173b53", backgroundColor: "transparent" };
    updatePage(selectedPage.id, { textBoxes: [...getPageTextBoxes(selectedPage), textBox] });
    setSelectedObject({ type: "textBox", id: textBox.id, pageId: selectedPage.id });
    setError("");
  };

  const removeTextBox = (pageId, textBoxId) => {
    const page = pagesRef.current.find((item) => item.id === pageId);
    updatePage(pageId, { textBoxes: getPageTextBoxes(page).filter((textBox) => textBox.id !== textBoxId) });
  };

  const reset = () => {
    if (job && jobMode !== "browser" && (job.status === "queued" || job.status === "processing")) deleteProcessingJob(jobMode, job.id).catch(() => undefined);
    if (saveJob && (saveJob.status === "queued" || saveJob.status === "processing")) deleteProcessingJob("local", saveJob.id).catch(() => undefined);
    for (const page of pages) for (const image of getPageImages(page)) if (image.url) { URL.revokeObjectURL(image.url); imageUrlsRef.current.delete(image.url); }
    documentsRef.current = [];
    if (browserResultUrlRef.current) URL.revokeObjectURL(browserResultUrlRef.current);
    browserResultUrlRef.current = "";
    clearDocumentHistory();
    pdfFilesRef.current = [];
    pagesRef.current = [];
    retainedJobIdRef.current = null;
    saveReplacementJobIdRef.current = "";
    setJobReplacementId("");
    resultFilenameTouchedRef.current = false;
    setPdfFiles([]); setPages([]); setSelectedId(null); setSelectedObject(null); setJob(null); setSaveJob(null); setSaveNotice(null); setJobKeepResult(false); setContinuingFile(null); setError(""); setPreviewError(""); setUploadProgress(0); setResultFilenameStem("");
  };

  const continueEditing = async (result, completedJobId = "") => {
    if (!result?.downloadUrl) { setError("The generated PDF is no longer available for editing."); return; }
    const retainedJobId = jobKeepResult ? (completedJobId || retainedJobIdRef.current) : retainedJobIdRef.current;
    try {
      const response = await fetch(result.downloadUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("The generated PDF could not be reopened.");
      const file = new File([await response.blob()], result.filename || "edited.pdf", { type: "application/pdf" });
      for (const page of pages) for (const image of getPageImages(page)) if (image.url) { URL.revokeObjectURL(image.url); imageUrlsRef.current.delete(image.url); }
      documentsRef.current = [];
      if (browserResultUrlRef.current) URL.revokeObjectURL(browserResultUrlRef.current);
      browserResultUrlRef.current = "";
      clearDocumentHistory();
      pdfFilesRef.current = [];
      pagesRef.current = [];
      retainedJobIdRef.current = retainedJobId;
      saveReplacementJobIdRef.current = "";
      setJobReplacementId("");
      setPdfFiles([]); setPages([]); setSelectedId(null); setSelectedObject(null); setJob(null); setJobKeepResult(false); setError(""); setPreviewError(""); setUploadProgress(0);
      resultFilenameTouchedRef.current = false;
      setResultFilenameStem("");
      setContinuingFile(file);
    } catch (continueError) {
      setError(continueError instanceof Error ? continueError.message : "The generated PDF could not be reopened.");
    }
  };

  const submit = async ({ saveToDevice = false } = {}) => {
    const validationError = validatePdfProject({ pages, pdfFiles, processingMode });
    if (validationError) { setError(`Export validation failed: ${validationError}`); return; }
    if (processingMode === "browser") {
      const browserError = browserPdfProjectError({ pages, pdfFiles });
      if (browserError) { setError(browserError); return; }
    }
    if (processingMode !== "browser" && !isProcessingLocationReady(locations, processingMode)) { setError("Admin login or activation is required in the Local agent dashboard."); return; }
    setError("");
    pushAnalyticsEvent("processing_started", { tool: "pdf-editor", mode: processingMode });
    setJobMode(processingMode);
    if (processingMode === "browser") {
      try {
        const activePdfLibrary = pdfLibrary || await ensurePdfLibrary();
        if (!pdfLibrary) setPdfLibrary(activePdfLibrary);
        const browserId = `browser-${makeId()}`;
        setJob({ id: browserId, status: "processing", progress: 0, stage: "Creating PDF in this browser", message: "Your PDF project is staying in this browser.", logs: [{ time: new Date().toISOString(), level: "info", message: "Browser PDF export started." }], warnings: [], error: null, result: null });
        const result = await exportPdfInBrowser(pdfFiles, pages, documentsRef.current, (progress) => setJob((current) => current ? { ...current, progress, stage: progress < 15 ? "Loading source PDFs" : progress < 20 ? "Preparing browser pages" : progress < 64 ? "Copying and arranging original pages" : progress < 75 ? "Creating final PDF" : "Preparing download", logs: [...(current.logs || []), { time: new Date().toISOString(), level: "info", message: `Browser export progress: ${progress}%.` }] } : current));
        browserResultUrlRef.current = result.downloadUrl;
        setJob((current) => current ? { ...current, status: "completed", progress: 100, stage: "Complete", message: result.fidelityWarning ? "The PDF was created in this browser, but some pages used a reduced-fidelity fallback." : result.previewError ? "The PDF was created in this browser. Its download is ready; the on-page preview could not be rendered." : "The PDF was created in this browser.", logs: [...(current.logs || []), ...(result.warnings || []).map((warning) => ({ time: new Date().toISOString(), level: "warn", message: warning })), ...(result.previewError ? [{ time: new Date().toISOString(), level: "warn", message: "The PDF was created successfully, but the browser preview could not be rendered." }] : []), { time: new Date().toISOString(), level: "info", message: "Browser PDF export completed." }], warnings: result.warnings || [], result } : current);
      } catch (browserError) {
        setJob((current) => current ? { ...current, status: "failed", error: browserError instanceof Error ? browserError.message : "The PDF could not be created in the browser." } : current);
      }
      return;
    }
    const form = new FormData();
    form.append("tool", "pdf-editor");
    pdfFiles.forEach((record) => form.append("pdf", record.file, record.name));
    let operations;
    try {
      operations = await Promise.all(pages.map(async (page) => {
        const operation = page.kind === "source"
          ? { kind: "source", pdfIndex: page.pdfIndex, pageIndex: page.pageIndex, width: page.width, height: page.height, rotation: normalizeRotation(page.rotation) }
          : { kind: "blank", width: page.width, height: page.height, rotation: normalizeRotation(page.rotation) };
        const images = getPageImages(page);
        if (page.kind === "raster") {
          const pdfPage = page.pdfPage || await documentsRef.current[page.pdfIndex]?.getPage(page.pageNumber);
          if (!pdfPage) throw new Error(`The protected PDF page ${page.pageNumber} could not be rendered for export.`);
          const rasterBytes = await renderPdfPageToJpeg(pdfPage);
          images.unshift({ id: "protected-page", file: new File([rasterBytes], `protected-page-${page.pageNumber}.jpg`, { type: "image/jpeg" }), x: 0, y: 0, width: page.width, height: page.height });
        }
        if (images.length) {
          if (page.kind === "source" || page.kind === "raster") Object.assign(operation, { width: page.width, height: page.height, rotation: page.rotation || 0 });
          operation.images = images.map((image, imageIndex) => {
            const imageField = `page-image-${page.id}-${image.id || imageIndex}`;
            form.append(imageField, image.file, image.file.name);
            return { imageField, image: { x: image.x, y: image.y, width: image.width, height: image.height, rotation: normalizeImageRotation(image.rotation) } };
          });
        }
        const textBoxes = getPageTextBoxes(page);
        if (textBoxes.length) {
          operation.textBoxes = textBoxes.map((textBox) => ({ id: textBox.id, text: String(textBox.text ?? ""), x: Number(textBox.x), y: Number(textBox.y), width: Number(textBox.width), height: Number(textBox.height), rotation: Number(textBox.rotation) || 0, fontSize: Number(textBox.fontSize), fontFamily: textBox.fontFamily, bold: Boolean(textBox.bold), italic: Boolean(textBox.italic), underline: Boolean(textBox.underline), color: textBox.color, backgroundColor: textBox.backgroundColor, runs: Array.isArray(textBox.runs) ? textBox.runs.map(textBoxRunPayload) : [] }));
        }
        return operation;
      }));
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : "A PDF page could not be prepared for export.");
      return;
    }
    form.append("operations", JSON.stringify(operations));
    const replacementJobId = processingMode === "local" ? retainedJobIdRef.current : "";
    const effectiveKeepResult = processingMode === "local" && (saveToDevice || Boolean(replacementJobId));
    form.append("filename", downloadFilename(resultFilenameStem || filenameStem(defaultResultFilename), defaultResultFilename));
    if (replacementJobId) form.append("replaceJobId", replacementJobId);
    if (processingMode === "local") {
      form.append("retention", effectiveKeepResult ? "keep" : "delete");
      form.append("historyStatus", saveToDevice ? "saved" : "completed");
    }
    try {
      setUploadProgress(1);
      const response = await uploadWithProgress(form, processingMode, setUploadProgress);
      setUploadProgress(0);
      setJobKeepResult(effectiveKeepResult);
      if (saveToDevice && processingMode === "local") {
        saveReplacementJobIdRef.current = replacementJobId;
        setSaveNotice(null);
        setSaveJob({ id: response.jobId, status: "queued", progress: 0, stage: "Saving…", message: "Saving the current PDF to this device…", logs: [], warnings: [], error: null, result: null });
      } else {
        setJobReplacementId(replacementJobId);
        setJob({ id: response.jobId, status: "queued", progress: 0, stage: "Queued", message: effectiveKeepResult ? "Waiting for the worker. The completed PDF will be saved to this device." : "Waiting for the worker.", logs: [], warnings: [], error: null, result: null });
      }
    } catch (submitError) {
      setUploadProgress(0);
      setError(submitError instanceof Error ? submitError.message : "The PDF project could not be uploaded.");
    }
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (activeView !== "tool" || job || loadingFiles) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, button, [contenteditable=\"true\"]")) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoDocument();
        else undoDocument();
        return;
      }
      if (command && event.key.toLowerCase() === "d") {
        event.preventDefault();
        void duplicateSelectedPage();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (processingMode === "local" && !saveJob) void submit({ saveToDevice: true });
        else if (processingMode !== "local") setError("Save to device requires Local agent mode.");
        return;
      }
      if (command && event.key === "Enter") {
        event.preventDefault();
        void submit();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        if (!selectedPage) return;
        event.preventDefault();
        deletePage(selectedPage.id);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        rotateSelectedPage(-90);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        rotateSelectedPage(90);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changePreviewZoom(0.1);
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        changePreviewZoom(-0.1);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        resetPreviewZoom();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeView, job, saveJob, loadingFiles, selectedPage, previewZoom, pages, pdfFiles, processingMode, canRedo, canUndo]);

  return <AppShell>
    <div className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> PDF tools <span className="pdf-capacity-note"><FileText size={14} /> Up to 5 PDFs · {processingMode === "browser" ? "50 MB total" : "200 MB total"}</span></div><h1>Free PDF editor</h1><p>{processingMode === "browser" ? "Import, merge, reorder, rotate, and remove PDF pages in this browser, or start with blank pages. Duplicating pages, styled text boxes, and password-protected PDFs require Local agent." : "Merge PDFs, reorder pages, remove pages, add images, or place styled text boxes on PDF pages and new blank pages."}</p></div></div>
    <ToolViewTabs value={activeView} onChange={setActiveView} />
    <ProcessingOptionsPanel tool="pdf-editor" locations={locations} value={processingMode} hidden={activeView !== "processing"} onSelect={selectProcessingMode} />
    {activeView === "history" ? <ToolHistory tool="pdf-editor" /> : activeView === "guide" ? <ToolSeoContent pathname="/pdf-editor" /> : activeView === "processing" ? null : <>
    {!job && <ProcessingMode value={processingMode} onChange={selectProcessingMode} onChangeView={() => setActiveView("processing")} locations={locations} tool="pdf-editor" />}
    {job ? <PdfJobCard job={job} mode={jobMode} keepResult={jobKeepResult} replacementJobId={jobReplacementId} onReset={reset} onContinue={continueEditing} /> : <section className={`pdf-editor-shell ${pdfDragActive ? "pdf-drop-active" : ""}`} onDragOver={handlePdfDragOver} onDragLeave={handlePdfDragLeave} onDrop={handlePdfDrop}>
      {processingMode === "local" && <div className="pdf-retention-row">
        <div className="pdf-editor-toolbar-heading pdf-retention-heading"><strong>Build your document</strong><span>{pdfFiles.length} of {MAX_PDF_COUNT} PDFs · {pages.length} pages · {Math.ceil(pdfFiles.reduce((total, record) => total + Number(record.file?.size || 0), 0) / (1024 * 1024)) || 0} MB of {processingMode === "browser" ? 50 : 200} MB</span></div>
        <div className="pdf-retention-name"><ResultFilenameField originalFilename={defaultResultFilename} value={resultFilenameStem || filenameStem(defaultResultFilename)} label="Saved PDF name" description="This name is used for the export and, when retained, for PDF editor History in the Results folder." onChange={(value) => { resultFilenameTouchedRef.current = true; setResultFilenameStem(filenameStem(value)); }} /></div>
        <button className="secondary-button pdf-save-button" type="button" onClick={() => submit({ saveToDevice: true })} disabled={!pages.length || Boolean(uploadProgress) || loadingFiles || Boolean(saveJob)} title="Save the current PDF to the Local agent Results folder without leaving the editor"><Save size={17} /> {saveJob ? "Saving…" : "Save to device"}</button>
      </div>}
      <div className={`pdf-editor-toolbar${processingMode === "local" ? " pdf-editor-toolbar-tools-only" : ""}`}>
        {processingMode !== "local" && <div className="pdf-editor-toolbar-heading"><strong>Build your document</strong><span>{pdfFiles.length} of {MAX_PDF_COUNT} PDFs · {pages.length} pages · {Math.ceil(pdfFiles.reduce((total, record) => total + Number(record.file?.size || 0), 0) / (1024 * 1024)) || 0} MB of {processingMode === "browser" ? 50 : 200} MB</span></div>}
        <div className="pdf-editor-actions">
          <button className="secondary-button" type="button" onClick={openPdfPicker} disabled={loadingFiles || pdfFiles.length >= MAX_PDF_COUNT} title="Add PDF"><Plus size={17} /> Add PDF</button>
          <button className="secondary-button" type="button" onClick={addBlankPage}><FilePlus2 size={17} /> Blank page</button>
          <div className="pdf-zoom-controls" aria-label="Preview zoom"><button className="icon-button" type="button" onClick={() => changePreviewZoom(-0.1)} aria-label="Zoom out" title="Zoom out (-)"><ZoomOut size={16} /></button><button className="pdf-zoom-value" type="button" onClick={resetPreviewZoom} title="Reset zoom (0)">{Math.round(previewZoom * 100)}%</button><button className="icon-button" type="button" onClick={() => changePreviewZoom(0.1)} aria-label="Zoom in" title="Zoom in (+)"><ZoomIn size={16} /></button></div>
          <div ref={moreToolsRef} className="pdf-more-tools">
            <button className="icon-button pdf-more-tools-trigger" type="button" aria-label="Open other PDF tools" aria-haspopup="menu" aria-expanded={moreToolsOpen} title={selectedPage ? "Other tools" : canUndo || canRedo ? "Undo or redo document changes" : "Add a page to use other tools"} disabled={!selectedPage && !canUndo && !canRedo} onClick={() => setMoreToolsOpen((current) => !current)}><MoreHorizontal size={20} /></button>
            {moreToolsOpen && (selectedPage || canUndo || canRedo) && <div className="pdf-more-tools-menu" role="menu" aria-label="Other PDF tools">
              <div className="pdf-more-tools-heading">History</div>
              <button type="button" role="menuitem" disabled={!canUndo} onClick={() => { setMoreToolsOpen(false); undoDocument(); }}><Undo2 size={16} /><span>Undo</span><kbd>⌘/Ctrl+Z</kbd></button>
              <button type="button" role="menuitem" disabled={!canRedo} onClick={() => { setMoreToolsOpen(false); redoDocument(); }}><Redo2 size={16} /><span>Redo</span><kbd>⇧⌘/Ctrl+Z</kbd></button>
              {selectedPage && <>
                <div className="pdf-more-tools-divider" />
                <div className="pdf-more-tools-heading">Page tools</div>
                <button type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); rotateSelectedPage(-90); }}><RotateCcw size={16} /><span>Rotate left</span><kbd>←</kbd></button>
                <button type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); rotateSelectedPage(90); }}><RotateCw size={16} /><span>Rotate right</span><kbd>→</kbd></button>
                <button className={processingMode === "browser" ? "pdf-local-only-menu-item" : ""} type="button" role="menuitem" aria-disabled={processingMode === "browser"} onClick={() => { setMoreToolsOpen(false); void duplicateSelectedPage(); }}><Copy size={16} /><span>Duplicate page{processingMode === "browser" ? " · Local agent only" : ""}</span>{processingMode === "browser" && <LockKeyhole size={12} aria-hidden="true" />}<kbd>⌘/Ctrl+D</kbd></button>
                <button type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); imageInputRef.current?.click(); }}><ImagePlus size={16} /><span>Add images</span></button>
                <button className={processingMode === "browser" ? "pdf-local-only-menu-item" : ""} type="button" role="menuitem" aria-disabled={processingMode === "browser"} onClick={() => { setMoreToolsOpen(false); addTextBox(); }}><Type size={16} /><span>Add text box{processingMode === "browser" ? " · Local agent only" : ""}</span>{processingMode === "browser" && <LockKeyhole size={12} aria-hidden="true" />}</button>
                {selectedPageImages.length > 0 && <button type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); removeAllImages(selectedPage.id); }}><Trash2 size={16} /><span>Remove images</span></button>}
                <div className="pdf-more-tools-divider" />
                <button className="pdf-more-tools-danger" type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); deletePage(selectedPage.id); }}><Trash2 size={16} /><span>Delete page</span><kbd>Delete</kbd></button>
              </>}
            </div>}
          </div>
          <button className="primary-button" type="button" onClick={submit} disabled={!pages.length || Boolean(uploadProgress) || loadingFiles} data-analytics-cta="export_pdf" data-analytics-surface="pdf-editor"><WandSparkles size={17} /> {uploadProgress ? `Uploading ${uploadProgress}%` : "Export PDF"}</button>
        </div>
      </div>
      <input ref={pdfInputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(event) => { addPdfFiles(event.target.files); event.target.value = ""; }} />
      <input ref={imageInputRef} type="file" accept={processingMode === "browser" ? "image/png,image/jpeg,.png,.jpg,.jpeg" : "image/png,image/jpeg,image/heic,image/heif,image/tiff,image/gif,image/bmp,.png,.jpg,.jpeg,.heic,.heif,.tif,.tiff,.gif,.bmp"} multiple hidden onChange={(event) => { const targetPageId = imageTargetPageIdRef.current; imageTargetPageIdRef.current = null; addImages(event.target.files, targetPageId || undefined); event.target.value = ""; }} />
      {!pdfFiles.length && !pages.length ? <PdfEmptyState onBrowse={openPdfPicker} onBlank={addBlankPage} loading={loadingFiles} dragActive={pdfDragActive} browserMode={processingMode === "browser"} /> : !pages.length ? <PdfNoPagesState onBrowse={openPdfPicker} onBlank={addBlankPage} browserMode={processingMode === "browser"} /> : <div className="pdf-editor-layout">
        <aside className="pdf-page-rail"><div className="pdf-rail-heading"><span>Pages</span><small>Pages load as you scroll</small></div><div ref={pageListRef} className="pdf-page-list" onDragOver={handlePageListDragOver} onDrop={handlePageListDrop} onWheel={handlePageListWheel} onPointerDown={handlePageListPointerDown} onPointerMove={(event) => { handlePagePointerMove(event); handlePageListPointerMove(event); }} onPointerUp={(event) => { finishPagePointerDrag(event); finishPageListPointerScroll(event); }} onPointerCancel={(event) => { finishPagePointerDrag(event, true); finishPageListPointerScroll(event); }}>{renderPageList()}</div></aside>
        <section className="pdf-selected-panel"><div className="pdf-selected-heading"><div><span>Selected page {selectedPage ? pages.findIndex((page) => page.id === selectedPage.id) + 1 : "—"}</span><small>{selectedPage?.kind === "blank" ? "Blank page" : selectedPage?.sourceName || "Choose a page"}{selectedPage?.kind === "source" ? ` · Original page ${selectedPage.pageNumber}` : ""}</small></div></div><div ref={previewScrollRef} className="pdf-document-preview" onScroll={handlePreviewScroll}>{pages.map((page, index) => <Fragment key={page.id}><PdfPreviewPage page={page} index={index} selected={page.id === selectedPage?.id} previewZoom={previewZoom} pdfDocument={documentsRef.current[page.pdfIndex]} previewRootRef={previewScrollRef} elementRef={(element) => { if (element) previewElementRefs.current.set(page.id, element); else previewElementRefs.current.delete(page.id); }} selectedObject={selectedObject?.pageId === page.id ? selectedObject : null} onSelectObject={(object) => setSelectedObject(object ? { ...object, pageId: page.id } : null)} onChange={(images, history) => updatePage(page.id, { images }, history)} onRemove={(imageId) => removeImage(page.id, imageId)} onChangeTextBoxes={(textBoxes, history) => updatePage(page.id, { textBoxes }, history)} onRemoveTextBox={(textBoxId) => removeTextBox(page.id, textBoxId)} onAddImages={() => openImagePickerForPage(page.id)} onError={setPreviewError} /><PdfInsertPageButton pageNumber={index + 1} onClick={() => addBlankPageAfter(page.id)} /></Fragment>)}</div>{previewError && <DismissibleMessage className="pdf-preview-error" resetKey={previewError}><AlertTriangle size={16} /><span>{previewError}</span></DismissibleMessage>}<p className="pdf-editor-tip"><GripVertical size={15} /> Scroll the preview to select a page. Click + Add page between previews to insert a blank page. {processingMode === "browser" ? "Add images up to 1 MB each; duplicate pages and styled text boxes require Local agent." : "Use Text box to add editable text to the selected page."}</p></section>
      </div>}
      {saveJob && <div className="pdf-save-progress" role="status" aria-live="polite"><LoaderCircle className="spin" size={16} /><span>{saveJob.message || "Saving the current PDF to this device…"}</span></div>}
      {saveNotice && <DismissibleMessage className={saveNotice.type === "success" ? "success-banner pdf-save-notice" : "error-banner pdf-save-notice"} resetKey={saveNotice.message}>{saveNotice.type === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={18} />}<span>{saveNotice.message}</span></DismissibleMessage>}
      {error && <DismissibleMessage className="error-banner" resetKey={error}><AlertTriangle size={18} /><span>{error}</span>{processingMode === "browser" && error.includes("Local agent") && <button className="secondary-button error-banner-action" type="button" onClick={useLocalAgent}>Use Local agent</button>}</DismissibleMessage>}
    </section>}
    <ToolFaqContent pathname="/pdf-editor" />
    </>}
  </AppShell>;
}

function PdfEmptyState({ onBrowse, onBlank, loading, dragActive, browserMode = false }) {
  return <div className="pdf-empty-state"><div className="pdf-empty-icon"><UploadCloud size={28} /></div><h2>{loading ? "Reading PDF pages…" : dragActive ? "Drop your PDF files" : "Start a PDF project"}</h2><p>{loading ? "Creating page previews for the editor." : dragActive ? "Release to add the PDFs to your project." : browserMode ? "Import and merge PDFs up to 50 MB total, or create a simple PDF from blank pages and PNG/JPG/JPEG images. Results are download-only in this browser." : "Upload one PDF to edit it, merge documents, or build a new PDF from blank pages."}</p><div className="pdf-empty-actions"><button className="primary-button" type="button" onClick={onBrowse} disabled={loading}><FilePlus2 size={18} /> Browse PDF files</button><button className="secondary-button" type="button" onClick={onBlank} disabled={loading}><FilePlus2 size={18} /> Start with blank page</button></div><small>{browserMode ? "Up to 5 PDFs · 50 MB total · PNG/JPG/JPEG images up to 1 MB each" : "Up to 5 PDFs · 200 MB total"}</small></div>;
}

function PdfNoPagesState({ onBrowse, onBlank, browserMode = false }) {
  return <div className="pdf-empty-state pdf-no-pages-state"><div className="pdf-empty-icon"><FileText size={28} /></div><h2>No pages left</h2><p>{browserMode ? "Add a blank page, or import another PDF to continue building your document in this browser." : "Add another PDF or add a blank page to continue building your document."}</p><div className="pdf-empty-actions"><button className="primary-button" type="button" onClick={onBrowse}><Plus size={18} /> Add PDF</button><button className="secondary-button" type="button" onClick={onBlank}><FilePlus2 size={18} /> Add blank page</button></div></div>;
}

function PdfPreviewPage({ page, index, selected, previewZoom, pdfDocument, previewRootRef, elementRef, selectedObject, onSelectObject, onChange, onRemove, onChangeTextBoxes, onRemoveTextBox, onAddImages, onError }) {
  const nodeRef = useRef(null);
  const [shouldRender, setShouldRender] = useState(index < 2);

  useEffect(() => {
    const node = nodeRef.current;
    const root = previewRootRef.current;
    if (!node) return undefined;
    if (!root || typeof IntersectionObserver !== "function") {
      setShouldRender(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShouldRender(true);
    }, { root, rootMargin: "900px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [previewRootRef, index]);

  const setNode = (element) => {
    nodeRef.current = element;
    elementRef?.(element);
  };
  const pageLabel = page.kind === "source" || page.kind === "raster" ? `Original page ${page.pageNumber}` : "New blank page";
  return <article ref={setNode} className={`pdf-preview-page ${selected ? "selected" : ""}`} aria-label={`Final page ${index + 1}, ${pageLabel}`}>
    <div className="pdf-preview-page-heading"><strong>Final page {index + 1}</strong><span>{pageLabel}{page.kind === "source" || page.kind === "raster" ? ` · ${page.sourceName}` : ""}{page.kind === "raster" ? " · Password-protected source" : ""}</span></div>
    {shouldRender ? page.kind === "blank" ? <BlankPageCanvas page={page} selectedObject={selectedObject} onSelectObject={onSelectObject} onChange={onChange} onRemove={onRemove} onChangeTextBoxes={onChangeTextBoxes} onRemoveTextBox={onRemoveTextBox} onAddImages={onAddImages} /> : page.previewFallback ? <PdfFallbackPreview page={page} compact selectedObject={selectedObject} onSelectObject={onSelectObject} onChange={onChange} onRemove={onRemove} onChangeTextBoxes={onChangeTextBoxes} onRemoveTextBox={onRemoveTextBox} /> : <PdfPageCanvas page={page} pdfDocument={pdfDocument} pageNumber={page.pageNumber} previewZoom={previewZoom} selectedObject={selectedObject} onSelectObject={onSelectObject} onError={onError} onChange={onChange} onRemove={onRemove} onChangeTextBoxes={onChangeTextBoxes} onRemoveTextBox={onRemoveTextBox} /> : <div className="pdf-preview-page-placeholder" style={{ "--page-ratio": pageDisplayRatio(page) }}><FileText size={24} /><span>Loading page {index + 1}</span></div>}
  </article>;
}

function PdfInsertPageButton({ pageNumber, onClick }) {
  return <div className="pdf-insert-page"><span className="pdf-insert-page-line" /><button className="pdf-insert-page-button" type="button" onClick={onClick} aria-label={`Add a blank page after page ${pageNumber}`} title={`Add a blank page after page ${pageNumber}`}><Plus size={17} /><span>Add page</span></button><span className="pdf-insert-page-line" /></div>;
}

function PdfPageThumbnail({ page, index, elementRef, thumbnailRootRef, pdfDocument, nativeDraggable = true, onThumbnailError, selected, draggedId, dropTargetId, dropPosition, recentlyDroppedId, onSelect, onKeyDown, onDelete, onDragStart, onDrag, onDragEnd, onDragOver, onDrop, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }) {
  return <>{dropTargetId === page.id && dropPosition === "before" && <div className="pdf-drop-gap" aria-hidden="true">Drop here</div>}<div ref={elementRef} className={`pdf-page-thumbnail ${selected ? "selected" : ""} ${draggedId === page.id ? "dragging" : ""} ${dropTargetId === page.id ? "drop-target" : ""} ${recentlyDroppedId === page.id && draggedId !== page.id ? "just-dropped" : ""}`} draggable={nativeDraggable} tabIndex={0} aria-label={`Select page ${index + 1}`} onClick={(event) => { event.currentTarget.focus(); onSelect?.(); }} onKeyDown={onKeyDown} onDragStart={onDragStart} onDrag={onDrag} onDragEnd={onDragEnd} onDragOver={onDragOver} onDrop={onDrop} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel}>
    <div className="thumbnail-frame">{page.kind === "source" || page.kind === "raster" ? <div className="thumbnail-page-surface" style={{ "--page-ratio": pageDisplayRatio(page) }}><PdfThumbnailImage page={page} index={index} pdfDocument={pdfDocument} rootRef={thumbnailRootRef} onError={onThumbnailError} /><ThumbnailImageOverlayLayer page={page} /><ThumbnailTextBoxOverlayLayer page={page} /></div> : <BlankPageMiniature page={page} />}</div>
    <div className="thumbnail-meta"><span className="thumbnail-drag-handle" aria-label={`Drag page ${index + 1}`} title="Drag to reorder"><GripVertical className="thumbnail-grip" size={14} /></span><span><strong>Final {index + 1}</strong>{page.kind === "source" || page.kind === "raster" ? <> · <span className="thumbnail-original-page">Original {page.pageNumber}</span> · {page.sourceName}</> : " · New blank page"}</span><button type="button" aria-label={`Delete page ${index + 1}`} title="Delete page" onClick={(event) => { event.stopPropagation(); onDelete(); }}><X size={14} /></button></div>
  </div>{dropTargetId === page.id && dropPosition === "after" && <div className="pdf-drop-gap" aria-hidden="true">Drop here</div>}</>;
}

function PdfThumbnailImage({ page, index, pdfDocument, rootRef, onError }) {
  const frameRef = useRef(null);
  const [active, setActive] = useState(index < 4);
  const [thumbnail, setThumbnail] = useState(page.thumbnail || null);

  useEffect(() => {
    if (index < 4) setActive(true);
  }, [index]);

  useEffect(() => {
    if (page.previewFallback && !pdfDocument) return;
    setThumbnail(null);
  }, [page.previewFallback, page.rotation, pdfDocument]);

  useEffect(() => {
    const frame = frameRef.current;
    const root = rootRef?.current;
    if (!frame || active) return undefined;
    if (!root || typeof IntersectionObserver !== "function") {
      setActive(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setActive(true);
    }, { root, rootMargin: "160px 0px" });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [active, rootRef]);

  useEffect(() => {
    let mounted = true;
    if (!active || thumbnail || !pdfDocument) return undefined;
    renderThumbnail(pdfDocument, page.pageNumber, page.rotation).then((result) => {
      if (mounted) setThumbnail(result.thumbnail);
    }).catch(() => {
      if (mounted) {
        setThumbnail(fallbackThumbnail(`Page ${page.pageNumber}`));
        onError?.();
      }
    });
    return () => { mounted = false; };
  }, [active, page.pageNumber, page.rotation, pdfDocument, thumbnail, onError]);

  if (!active) return <div ref={frameRef} className="thumbnail-loading" aria-label={`Page ${index + 1} thumbnail will load when visible`}>Scroll to load</div>;
  if (!thumbnail) return <div ref={frameRef} className="thumbnail-loading" aria-label={`Loading page ${index + 1} thumbnail`}>Loading…</div>;
  return <img ref={frameRef} className="thumbnail-page-image" src={thumbnail} alt={`Page ${index + 1}`} draggable="false" loading={index < 4 ? "eager" : "lazy"} decoding="async" style={page.previewFallback ? { transform: `rotate(${normalizeRotation(page.rotation)}deg)` } : undefined} />;
}

function ThumbnailImageOverlayLayer({ page }) {
  return <div className="thumbnail-image-overlay-layer">{getPageImages(page).map((image, index) => { const placement = imageDisplayPlacement(page, image); return <div className="thumbnail-image-overlay" key={image.id || index} style={{ ...imageOverlayFrameStyle(placement), transform: `rotate(${normalizeImageRotation(image.rotation)}deg)`, transformOrigin: "center center" }}><img src={image.url} alt="" aria-hidden="true" draggable="false" style={imagePreviewStyle(page, image, placement)} /></div>; })}</div>;
}

function ThumbnailTextBoxOverlayLayer({ page }) {
  return <div className="thumbnail-text-box-overlay-layer">{getPageTextBoxes(page).map((textBox, index) => { const placement = imageDisplayPlacement(page, textBox); const thumbnailScale = Math.min(0.25, 180 / Math.max(1, page.width)); return <div className="thumbnail-text-box-overlay" key={textBox.id || index} style={imageOverlayFrameStyle(placement)}>{textBoxTextRuns(textBox).map((run, runIndex) => <span key={`${textBox.id || index}-${runIndex}`} style={{ fontFamily: textBoxCssFontFamily(run.fontFamily), fontSize: `${Math.max(3, Number(run.fontSize) || 18) * thumbnailScale}px`, fontWeight: run.bold ? 700 : 400, fontStyle: run.italic ? "italic" : "normal", textDecoration: run.underline ? "underline" : "none", color: validHexColor(run.color) ? run.color : "#173b53", backgroundColor: run.backgroundColor === "transparent" ? "transparent" : validHexColor(run.backgroundColor) ? run.backgroundColor : "transparent", whiteSpace: "pre-wrap" }}>{run.text}</span>)}</div>; })}</div>;
}

function BlankPageMiniature({ page }) {
  const images = getPageImages(page);
  return <div className="blank-page-mini" style={{ aspectRatio: pageDisplayRatio(page) }}>{images.map((image, index) => { const placement = imageDisplayPlacement(page, image); return <div className="blank-page-mini-image" key={image.id || index} style={{ ...imageOverlayFrameStyle(placement), transform: `rotate(${normalizeImageRotation(image.rotation)}deg)`, transformOrigin: "center center" }}><img src={image.url} alt={`Image ${index + 1} on blank page`} draggable="false" style={imagePreviewStyle(page, image, placement)} /></div>; })}<ThumbnailTextBoxOverlayLayer page={page} /></div>;
}

function imageOverlayFrameStyle(placement) {
  return {
    left: `${placement.x / placement.pageWidth * 100}%`,
    top: `${placement.y / placement.pageHeight * 100}%`,
    width: `${placement.width / placement.pageWidth * 100}%`,
    height: `${placement.height / placement.pageHeight * 100}%`,
  };
}

function imagePreviewStyle(page, image, placement) {
  const pageRotation = normalizeRotation(page?.rotation);
  const quarterTurn = pageRotation === 90 || pageRotation === 270;
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: quarterTurn ? `${Number(image.width) / Math.max(1, Number(placement.width)) * 100}%` : "100%",
    height: quarterTurn ? `${Number(image.height) / Math.max(1, Number(placement.height)) * 100}%` : "100%",
    transform: `translate(-50%, -50%) rotate(${pageRotation}deg)`,
    transformOrigin: "center",
    objectFit: "fill",
  };
}

function PdfPageCanvas({ page, pdfDocument, pageNumber, previewZoom = 1, selectedObject, onSelectObject, onError, onChange, onRemove, onChangeTextBoxes, onRemoveTextBox }) {
  const canvasRef = useRef(null);
  const frameRef = useRef(null);
  const surfaceRef = useRef(null);
  const [pageInfo, setPageInfo] = useState(null);
  const [surfaceSize, setSurfaceSize] = useState(null);
  useEffect(() => {
    let active = true;
    if (!pdfDocument) return undefined;
    pdfDocument.getPage(pageNumber).then((pdfPage) => {
      if (!active) return;
      const baseViewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
      setPageInfo({ pdfPage, width: baseViewport.width, height: baseViewport.height });
    }).catch(() => { if (active) onError("This PDF page could not be rendered in the browser."); });
    return () => { active = false; };
  }, [pdfDocument, pageNumber, onError]);

  useEffect(() => {
    let active = true;
    if (!pageInfo || !frameRef.current || !surfaceRef.current || !canvasRef.current) return undefined;
    let drawing = false;
    const draw = async () => {
      if (!active || drawing || !frameRef.current || !surfaceRef.current || !canvasRef.current) return;
      drawing = true;
      const frame = frameRef.current;
      const surface = surfaceRef.current;
      const rotation = normalizeRotation(page.rotation);
      const baseViewport = pageInfo.pdfPage.getViewport({ scale: 1, rotation });
      const frameStyle = window.getComputedStyle(frame);
      const paddingWidth = (Number.parseFloat(frameStyle.paddingLeft) || 0) + (Number.parseFloat(frameStyle.paddingRight) || 0);
      const availableWidth = Math.max(1, frame.clientWidth - paddingWidth);
      const { maxPreviewHeight } = previewViewportLimits({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight });
      const layout = calculatePreviewPageLayout({ pageWidth: baseViewport.width, pageHeight: baseViewport.height, availableWidth, maxPreviewHeight, zoom: previewZoom });
      const scale = layout.scale;
      // Keep the displayed page at the same CSS size, but render its backing
      // canvas at 2x (or the display's native density) so text and vector
      // artwork stay sharp in the full preview. Thumbnails intentionally use
      // their smaller render path.
      const pixelRatio = Math.min(3, Math.max(2, Number(window.devicePixelRatio) || 1));
      const displayViewport = pageInfo.pdfPage.getViewport({ scale, rotation });
      setSurfaceSize((previous) => previous && Math.abs(previous.width - displayViewport.width) < 0.1 && Math.abs(previous.height - displayViewport.height) < 0.1 && previous.isZoomed === layout.isZoomed
        ? previous
        : { width: displayViewport.width, height: displayViewport.height, isZoomed: layout.isZoomed });
      const renderViewport = pageInfo.pdfPage.getViewport({ scale: scale * pixelRatio, rotation });
      const canvas = canvasRef.current;
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      try {
        await pageInfo.pdfPage.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: renderViewport }).promise;
      } finally {
        drawing = false;
      }
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => { draw().catch(() => { if (active) onError("This PDF page could not be rendered in the browser."); }); }) : null;
    observer?.observe(frameRef.current);
    draw().catch(() => { if (active) onError("This PDF page could not be rendered in the browser."); });
    return () => { active = false; observer?.disconnect(); };
  }, [pageInfo, page.rotation, previewZoom, onError]);

  const ratio = pageInfo ? pageDisplayRatio({ ...page, width: pageInfo.width, height: pageInfo.height }) : pageDisplayRatio(page);
  return <div ref={frameRef} className="pdf-page-canvas-wrap" data-preview-zoomed={surfaceSize?.isZoomed ? "true" : "false"}><div ref={surfaceRef} className="pdf-page-canvas-surface" style={{ "--page-ratio": ratio, ...(surfaceSize ? { width: `${surfaceSize.width}px`, height: `${surfaceSize.height}px` } : {}) }} onPointerDown={(event) => { if (event.target === event.currentTarget || event.target === canvasRef.current) onSelectObject?.(null); }}><canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} /><ImageOverlayLayer page={page} selectedImageId={selectedObject?.type === "image" ? selectedObject.id : null} onSelect={(id) => onSelectObject?.({ type: "image", id })} onChange={onChange} onRemove={onRemove} /><TextBoxOverlayLayer page={page} selectedTextBoxId={selectedObject?.type === "textBox" ? selectedObject.id : null} onSelect={(id) => onSelectObject?.({ type: "textBox", id })} onChange={onChangeTextBoxes} onRemove={onRemoveTextBox} /></div></div>;
}

function PdfFallbackPreview({ page, compact = false, selectedObject, onSelectObject, onChange, onRemove, onChangeTextBoxes, onRemoveTextBox }) {
  const previewUrl = page.previewToken ? `/api/pdf/preview?token=${encodeURIComponent(page.previewToken)}&page=${page.pageNumber}` : "";
  return <div className="pdf-page-fallback"><div className="pdf-page-fallback-stage" style={{ "--page-ratio": pageDisplayRatio(page) }} onPointerDown={(event) => { if (event.target === event.currentTarget) onSelectObject?.(null); }}>{previewUrl ? <img src={previewUrl} alt={`Preview of PDF page ${page.pageNumber}`} style={{ transform: `rotate(${normalizeRotation(page.rotation)}deg)` }} /> : <div className="pdf-page-fallback-empty"><FileText size={28} /><strong>Preview is unavailable</strong></div>}<ImageOverlayLayer page={page} selectedImageId={selectedObject?.type === "image" ? selectedObject.id : null} onSelect={(id) => onSelectObject?.({ type: "image", id })} onChange={onChange} onRemove={onRemove} /><TextBoxOverlayLayer page={page} selectedTextBoxId={selectedObject?.type === "textBox" ? selectedObject.id : null} onSelect={(id) => onSelectObject?.({ type: "textBox", id })} onChange={onChangeTextBoxes} onRemove={onRemoveTextBox} /></div>{!compact && <div className="pdf-page-fallback-note"><FileText size={22} /><strong>Local-agent PDF preview</strong><span>Page {page.pageNumber} is ready to include in the exported PDF.</span></div>}</div>;
}

function BlankPageCanvas({ page, selectedObject, onSelectObject, onChange, onRemove, onChangeTextBoxes, onRemoveTextBox, onAddImages }) {
  const images = getPageImages(page);
  const textBoxes = getPageTextBoxes(page);
  return <div className="blank-page-preview-area"><div className="blank-page-canvas" style={{ "--page-ratio": pageDisplayRatio(page) }} onPointerDown={(event) => { if (event.target === event.currentTarget) onSelectObject?.(null); }}>{images.length ? <ImageOverlayLayer page={page} selectedImageId={selectedObject?.type === "image" ? selectedObject.id : null} onSelect={(id) => onSelectObject?.({ type: "image", id })} onChange={onChange} onRemove={onRemove} /> : textBoxes.length ? null : <button className="blank-page-message" type="button" onClick={onAddImages}><ImagePlus size={25} /><span>Add images to this blank page</span></button>}<TextBoxOverlayLayer page={page} selectedTextBoxId={selectedObject?.type === "textBox" ? selectedObject.id : null} onSelect={(id) => onSelectObject?.({ type: "textBox", id })} onChange={onChangeTextBoxes} onRemove={onRemoveTextBox} /></div><p className="blank-page-help">{images.length ? "Select an object to show its handles. Drag the corner and side handles to resize it, or drag the dot above it to rotate." : textBoxes.length ? "Select a text box to show its handles and formatting controls." : "Click the blank page to add images or use Text box to add editable text."}</p></div>;
}

function objectCenterInLayer(page, object, bounds) {
  const placement = imageDisplayPlacement(page, object);
  const dimensions = pageDisplayDimensions(page);
  return {
    x: bounds.left + ((placement.x + placement.width / 2) / Math.max(1, dimensions.width)) * bounds.width,
    y: bounds.top + ((placement.y + placement.height / 2) / Math.max(1, dimensions.height)) * bounds.height,
  };
}

function resizedObject(object, handle, pageDelta, shiftKey = false) {
  const [directionX, directionY] = PDF_OBJECT_HANDLE_DIRECTIONS[handle] || [1, 1];
  const rotation = Number(object.rotation) || 0;
  const localDelta = rotatePoint(pageDelta, -rotation);
  const originalWidth = Math.max(24, Number(object.width) || 24);
  const originalHeight = Math.max(24, Number(object.height) || 24);
  const corner = directionX !== 0 && directionY !== 0;
  const locked = corner && (object.lockAspectRatio === true || shiftKey);
  let width = originalWidth;
  let height = originalHeight;
  if (locked) {
    const factor = Math.max(24 / originalWidth, 24 / originalHeight, 1 + (directionX * localDelta.x / originalWidth + directionY * localDelta.y / originalHeight) / 2);
    width = originalWidth * factor;
    height = originalHeight * factor;
  } else {
    if (directionX !== 0) width = Math.max(24, originalWidth + directionX * localDelta.x);
    if (directionY !== 0) height = Math.max(24, originalHeight + directionY * localDelta.y);
  }
  width = Math.min(MAX_IMAGE_COORDINATE, width);
  height = Math.min(MAX_IMAGE_COORDINATE, height);
  const oldAnchor = {
    x: directionX < 0 ? originalWidth : directionX > 0 ? 0 : originalWidth / 2,
    y: directionY < 0 ? originalHeight : directionY > 0 ? 0 : originalHeight / 2,
  };
  const newAnchor = {
    x: directionX < 0 ? width : directionX > 0 ? 0 : width / 2,
    y: directionY < 0 ? height : directionY > 0 ? 0 : height / 2,
  };
  const oldAnchorPage = { x: Number(object.x) + rotatePoint(oldAnchor, rotation).x, y: Number(object.y) + rotatePoint(oldAnchor, rotation).y };
  const newAnchorOffset = rotatePoint(newAnchor, rotation);
  return {
    ...object,
    x: Math.max(-MAX_IMAGE_COORDINATE, Math.min(MAX_IMAGE_COORDINATE - width, oldAnchorPage.x - newAnchorOffset.x)),
    y: Math.max(-MAX_IMAGE_COORDINATE, Math.min(MAX_IMAGE_COORDINATE - height, oldAnchorPage.y - newAnchorOffset.y)),
    width,
    height,
  };
}

function ImageOverlayLayer({ page, selectedImageId, onSelect, onChange, onRemove }) {
  const layerRef = useRef(null);
  const interactionRef = useRef(null);
  const images = getPageImages(page);

  const onPointerDown = (event, mode, image, handle = "") => {
    if (!image || !layerRef.current || event.button !== 0) return;
    const bounds = layerRef.current.getBoundingClientRect();
    const placement = imageDisplayPlacement(page, image);
    const interaction = { mode, handle, imageId: image.id, startX: event.clientX, startY: event.clientY, bounds, image: { ...image }, placement };
    if (mode === "rotate") {
      interaction.center = objectCenterInLayer(page, image, bounds);
      interaction.startAngle = Math.atan2(event.clientY - interaction.center.y, event.clientX - interaction.center.x) * 180 / Math.PI;
      interaction.rotation = Number(image.rotation) || 0;
    }
    interactionRef.current = interaction;
    onSelect?.(image.id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerMove = (event) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    if (event.pointerType === "mouse" && (event.buttons & 1) !== 1) {
      interactionRef.current = null;
      return;
    }
    const image = images.find((item) => item.id === interaction.imageId);
    if (!image) return;
    if (interaction.mode === "rotate") {
      const angle = Math.atan2(event.clientY - interaction.center.y, event.clientX - interaction.center.x) * 180 / Math.PI;
      const delta = ((angle - interaction.startAngle + 540) % 360) - 180;
      onChange(images.map((item) => item.id === interaction.imageId ? { ...item, rotation: normalizeImageRotation(interaction.rotation + delta) } : item), "coalesce");
      return;
    }
    const dimensions = pageDisplayDimensions(page);
    const displayDx = (event.clientX - interaction.startX) * dimensions.width / Math.max(1, interaction.bounds.width);
    const displayDy = (event.clientY - interaction.startY) * dimensions.height / Math.max(1, interaction.bounds.height);
    const pageDelta = displayedDeltaToPage(page, displayDx, displayDy);
    const next = interaction.mode === "move"
      ? { ...interaction.image, x: Math.max(-MAX_IMAGE_COORDINATE, Math.min(MAX_IMAGE_COORDINATE - interaction.image.width, interaction.image.x + pageDelta.x)), y: Math.max(-MAX_IMAGE_COORDINATE, Math.min(MAX_IMAGE_COORDINATE - interaction.image.height, interaction.image.y + pageDelta.y)) }
      : resizedObject(interaction.image, interaction.handle, pageDelta, event.shiftKey);
    onChange(images.map((item) => item.id === interaction.imageId ? next : item), "coalesce");
  };
  const onPointerUp = () => { interactionRef.current = null; };
  const toggleAspectRatio = (imageId) => onChange(images.map((item) => item.id === imageId ? { ...item, lockAspectRatio: item.lockAspectRatio === false } : item));
  const updateImageRotation = (imageId, value) => {
    const rotation = Number(value);
    if (!Number.isFinite(rotation)) return;
    onChange(images.map((item) => item.id === imageId ? { ...item, rotation: normalizeImageRotation(rotation) } : item));
  };
  const rotateImage = (imageId, delta) => {
    const image = images.find((item) => item.id === imageId);
    updateImageRotation(imageId, normalizeImageRotation((image?.rotation || 0) + delta));
  };

  return <div ref={layerRef} className="pdf-image-overlay-layer" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>{images.map((image, index) => { const placement = imageDisplayPlacement(page, image); const selected = selectedImageId === image.id; return <div className={`pdf-image-overlay ${selected ? "selected" : ""}`} key={image.id || index} style={{ ...objectFrameStyle(placement, image.rotation), zIndex: index + 1 }} onPointerDown={(event) => onPointerDown(event, "move", image)}><img src={image.url} alt={`Placed image ${index + 1}`} draggable="false" style={imagePreviewStyle(page, image, placement)} />{selected && <><ObjectTransformHandles object={image} label={`image ${index + 1}`} onResizeStart={(event, handle) => onPointerDown(event, "resize", image, handle)} onRotateStart={(event) => onPointerDown(event, "rotate", image)} /><button type="button" className="image-remove-handle" aria-label={`Remove image ${index + 1}`} title="Remove image" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove?.(image.id); }}><X size={11} /></button><button type="button" className="image-ratio-handle" aria-label={image.lockAspectRatio === false ? `Keep image ${index + 1} aspect ratio` : `Allow image ${index + 1} free resizing`} title={image.lockAspectRatio === false ? "Keep aspect ratio" : "Allow free resizing"} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); toggleAspectRatio(image.id); }}>{image.lockAspectRatio === false ? <Unlock size={10} /> : <Lock size={10} />}</button></>}</div>; })}</div>;
}

function TextBoxOverlayLayer({ page, selectedTextBoxId, onSelect, onChange, onRemove }) {
  const layerRef = useRef(null);
  const interactionRef = useRef(null);
  const editorRefs = useRef(new Map());
  const selectionRef = useRef(null);
  const restoreSelectionRef = useRef(false);
  const [scale, setScale] = useState(1);
  const textBoxes = getPageTextBoxes(page);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return undefined;
    const updateScale = () => setScale(layer.getBoundingClientRect().width / Math.max(1, pageDisplayDimensions(page).width));
    updateScale();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(updateScale);
    observer.observe(layer);
    return () => observer.disconnect();
  }, [page.width, page.height, page.rotation]);
  useLayoutEffect(() => {
    const selection = selectionRef.current;
    if (!restoreSelectionRef.current || !selection || selection.start < 0 || selection.end < selection.start) return;
    const editor = editorRefs.current.get(selection.textBoxId);
    if (!editor) return;
    restoreTextSelection(editor, selection);
    restoreSelectionRef.current = false;
  }, [page]);
  const updateTextBox = (textBoxId, changes, history = "discrete") => onChange?.(textBoxes.map((textBox) => textBox.id === textBoxId ? { ...textBox, ...changes } : textBox), history);
  const captureSelection = (textBoxId) => {
    const editor = editorRefs.current.get(textBoxId);
    const offsets = textSelectionOffsets(editor);
    if (offsets) selectionRef.current = { textBoxId, ...offsets };
    return offsets || (selectionRef.current?.textBoxId === textBoxId ? selectionRef.current : null);
  };
  const selectedRunsFor = (textBox) => {
    const selection = selectionRef.current;
    if (!selection || selection.textBoxId !== textBox.id || selection.end <= selection.start) return [];
    return textBoxTextRuns(textBox).filter((run) => run.end > selection.start && run.start < selection.end);
  };
  const styleValueFor = (textBox, key) => {
    const selectedRuns = selectedRunsFor(textBox);
    if (selectedRuns.length && selectedRuns.every((run) => run[key] === selectedRuns[0][key])) return selectedRuns[0][key];
    return textBox[key];
  };
  const stylePressedFor = (textBox, key) => {
    const selectedRuns = selectedRunsFor(textBox);
    return selectedRuns.length ? selectedRuns.every((run) => Boolean(run[key])) : Boolean(textBox[key]);
  };
  const applyTextBoxStyle = (textBoxId, key, value) => {
    const textBox = textBoxes.find((item) => item.id === textBoxId);
    if (!textBox) return;
    const selection = selectionRef.current?.textBoxId === textBoxId ? selectionRef.current : null;
    const next = selection && selection.end > selection.start
      ? applyTextBoxRangeStyle(textBox, selection.start, selection.end, { [key]: value })
      : applyTextBoxWholeStyle(textBox, { [key]: value });
    restoreSelectionRef.current = Boolean(selection && selection.end > selection.start);
    updateTextBox(textBoxId, { [key]: value, runs: next.runs });
  };
  const toggleTextBoxStyle = (textBox, key) => applyTextBoxStyle(textBox.id, key, !stylePressedFor(textBox, key));
  const updateTextBoxText = (textBox, event) => {
    const editor = event.currentTarget;
    const nextText = String(editor.innerText || "").replace(/\r\n/g, "\n");
    const offsets = textSelectionOffsets(editor);
    const runs = rebaseTextBoxRuns(textBox, nextText);
    if (offsets) {
      selectionRef.current = { textBoxId: textBox.id, ...offsets };
      restoreSelectionRef.current = true;
    }
    updateTextBox(textBox.id, { text: nextText, runs }, "coalesce");
  };
  const handleTextBoxKeyDown = (textBox, event) => {
    const command = event.metaKey || event.ctrlKey;
    if (!command) return;
    const key = event.key.toLowerCase();
    const styleKey = key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : "";
    if (!styleKey) return;
    event.preventDefault();
    captureSelection(textBox.id);
    toggleTextBoxStyle(textBox, styleKey);
  };
  const onPointerDown = (event, mode, textBox, handle = "") => {
    if (!textBox || !layerRef.current || event.button !== 0) return;
    const bounds = layerRef.current.getBoundingClientRect();
    const placement = imageDisplayPlacement(page, textBox);
    const interaction = { mode, handle, textBoxId: textBox.id, startX: event.clientX, startY: event.clientY, bounds, textBox: { ...textBox }, placement };
    if (mode === "rotate") {
      interaction.center = objectCenterInLayer(page, textBox, bounds);
      interaction.startAngle = Math.atan2(event.clientY - interaction.center.y, event.clientX - interaction.center.x) * 180 / Math.PI;
      interaction.rotation = Number(textBox.rotation) || 0;
    }
    interactionRef.current = interaction;
    onSelect?.(textBox.id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerMove = (event) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const textBox = textBoxes.find((item) => item.id === interaction.textBoxId);
    if (!textBox) return;
    if (interaction.mode === "rotate") {
      const angle = Math.atan2(event.clientY - interaction.center.y, event.clientX - interaction.center.x) * 180 / Math.PI;
      const delta = ((angle - interaction.startAngle + 540) % 360) - 180;
      onChange?.(textBoxes.map((item) => item.id === interaction.textBoxId ? { ...item, rotation: interaction.rotation + delta } : item), "coalesce");
      return;
    }
    const displayDimensions = pageDisplayDimensions(page);
    const displayDx = (event.clientX - interaction.startX) * displayDimensions.width / Math.max(1, interaction.bounds.width);
    const displayDy = (event.clientY - interaction.startY) * displayDimensions.height / Math.max(1, interaction.bounds.height);
    const pageDelta = displayedDeltaToPage(page, displayDx, displayDy);
    const next = interaction.mode === "move"
      ? { ...interaction.textBox, x: Math.max(-MAX_IMAGE_COORDINATE, Math.min(MAX_IMAGE_COORDINATE - interaction.textBox.width, interaction.textBox.x + pageDelta.x)), y: Math.max(-MAX_IMAGE_COORDINATE, Math.min(MAX_IMAGE_COORDINATE - interaction.textBox.height, interaction.textBox.y + pageDelta.y)) }
      : resizedObject(interaction.textBox, interaction.handle, pageDelta, event.shiftKey);
    onChange?.(textBoxes.map((item) => item.id === interaction.textBoxId ? next : item), "coalesce");
  };
  const onPointerUp = () => { interactionRef.current = null; };
  return <div ref={layerRef} className="pdf-text-box-overlay-layer" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>{textBoxes.map((textBox, index) => {
    const placement = imageDisplayPlacement(page, textBox);
    const selectedRuns = selectedRunsFor(textBox);
    const color = String(styleValueFor(textBox, "color") || "#173b53");
    const backgroundColor = String(styleValueFor(textBox, "backgroundColor") || "transparent");
    const fontFamily = String(styleValueFor(textBox, "fontFamily") || "Helvetica");
    const fontSize = Number(styleValueFor(textBox, "fontSize")) || 18;
    const formatButton = (key, Icon, label) => <button type="button" className="pdf-text-box-style-button" aria-label={`${label} text ${selectedRuns.length ? "selection" : `box ${index + 1}`}`} aria-pressed={stylePressedFor(textBox, key)} title={label} onMouseDown={(event) => { event.preventDefault(); captureSelection(textBox.id); toggleTextBoxStyle(textBox, key); }}><Icon size={11} /></button>;
    const selected = selectedTextBoxId === textBox.id;
    return <div className={`pdf-text-box-overlay ${selected ? "selected" : ""}`} key={textBox.id || index} style={{ ...objectFrameStyle(placement, textBox.rotation), zIndex: index + 3 }} onPointerDown={(event) => onPointerDown(event, "move", textBox)}>
      <div className="pdf-text-box-content" style={textBoxPreviewStyle(page, textBox, scale)}>
        <div ref={(element) => { if (element) editorRefs.current.set(textBox.id, element); else editorRefs.current.delete(textBox.id); }} className="pdf-text-box-editor" contentEditable suppressContentEditableWarning spellCheck="false" role="textbox" aria-label={`Text box ${index + 1} text`} data-placeholder="Type text here" onPointerDown={(event) => { event.stopPropagation(); onSelect?.(textBox.id); }} onMouseUp={() => captureSelection(textBox.id)} onKeyUp={() => captureSelection(textBox.id)} onKeyDown={(event) => handleTextBoxKeyDown(textBox, event)} onBlur={() => captureSelection(textBox.id)} onInput={(event) => updateTextBoxText(textBox, event)} dangerouslySetInnerHTML={{ __html: textBoxEditorHtml(textBox, scale) }} />
      </div>
      {selected && <><ObjectTransformHandles object={textBox} label={`text box ${index + 1}`} onResizeStart={(event, handle) => onPointerDown(event, "resize", textBox, handle)} onRotateStart={(event) => onPointerDown(event, "rotate", textBox)} /><div className="pdf-text-box-controls" onPointerDown={(event) => event.stopPropagation()}>
        <select value={fontFamily} aria-label={`Font for text ${selectedRuns.length ? "selection" : `box ${index + 1}`}`} title="Font for text box or selection" onPointerDown={() => captureSelection(textBox.id)} onChange={(event) => applyTextBoxStyle(textBox.id, "fontFamily", event.target.value)}>{PDF_TEXT_BOX_FONTS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select>
        <input type="number" min="1" max="500" step="1" value={fontSize} aria-label={`Text size for text ${selectedRuns.length ? "selection" : `box ${index + 1}`}`} title="Text size for text box or selection" onPointerDown={() => captureSelection(textBox.id)} onChange={(event) => applyTextBoxStyle(textBox.id, "fontSize", Math.max(1, Math.min(500, Number(event.target.value) || 1)))} />
        {formatButton("bold", Bold, "Bold")}{formatButton("italic", Italic, "Italic")}{formatButton("underline", Underline, "Underline")}
        <label className="pdf-text-box-color" title="Text color for text box or selection"><span className="sr-only">Text color</span><input type="color" value={validHexColor(color) ? color : "#173b53"} aria-label={`Text color for text ${selectedRuns.length ? "selection" : `box ${index + 1}`}`} onPointerDown={() => captureSelection(textBox.id)} onChange={(event) => applyTextBoxStyle(textBox.id, "color", event.target.value)} /></label>
        <label className="pdf-text-box-color" title="Background color for text box or selection"><span className="sr-only">Background color</span><input type="color" value={validHexColor(backgroundColor) ? backgroundColor : "#ffffff"} aria-label={`Background color for text ${selectedRuns.length ? "selection" : `box ${index + 1}`}`} onPointerDown={() => captureSelection(textBox.id)} onChange={(event) => applyTextBoxStyle(textBox.id, "backgroundColor", event.target.value)} /></label>
        <button type="button" className="pdf-text-box-clear-background" onMouseDown={(event) => { event.preventDefault(); captureSelection(textBox.id); applyTextBoxStyle(textBox.id, "backgroundColor", "transparent"); }}>Clear</button>
      </div><button type="button" className="text-box-remove-handle" aria-label={`Remove text box ${index + 1}`} title="Remove text box" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove?.(textBox.id); }}><X size={11} /></button></>}
    </div>;
  })}</div>;
}

function pdfPreviewUrl(result) {
  const downloadUrl = result?.previewUrl || result?.downloadUrl;
  if (!downloadUrl) return "";
  // Browser results already provide a blob URL. Appending a query string to a
  // blob URL makes it a different, invalid object URL in some embedded browsers.
  if (/^(blob:|data:)/i.test(downloadUrl)) return downloadUrl;
  return `${downloadUrl}${downloadUrl.includes("?") ? "&" : "?"}preview=1`;
}

function PdfResultPreview({ result }) {
  const [pages, setPages] = useState([]);
  const [totalPages, setTotalPages] = useState(result?.pageCount || 0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setPages([]);
    setTotalPages(result?.pageCount || 0);
    setLoading(true);
    setError("");

    const loadPreview = async () => {
      try {
        const sourceUrl = pdfPreviewUrl(result);
        if (!sourceUrl) throw new Error("The PDF preview URL is unavailable.");
        const response = await fetch(sourceUrl, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          let detail = "The generated PDF could not be loaded for preview.";
          try {
            const payload = await response.json();
            if (payload?.error) detail = payload.error;
          } catch { /* The response may be a non-JSON error page. */ }
          throw new Error(detail);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        const pdfLibrary = await loadPdfLibrary();
        const documentProxy = await pdfLibrary.getDocument({ data }).promise;
        if (!active) return;
        setTotalPages(documentProxy.numPages);

        for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
          const pdfPage = await documentProxy.getPage(pageNumber);
          const baseViewport = pdfPage.getViewport({ scale: 1 });
          const scale = Math.min(1, 860 / baseViewport.width);
          const viewport = pdfPage.getViewport({ scale });
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width * pixelRatio);
          canvas.height = Math.ceil(viewport.height * pixelRatio);
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("This browser could not create a PDF preview canvas.");
          await pdfPage.render({
            canvasContext: context,
            viewport: pdfPage.getViewport({ scale: scale * pixelRatio }),
          }).promise;
          const source = canvas.toDataURL("image/jpeg", 0.82);
          if (!active) return;
          setPages((current) => [...current, { pageNumber, source }]);
        }
        if (active) setLoading(false);
      } catch (previewError) {
        if (!active || previewError?.name === "AbortError") return;
        setError(previewError instanceof Error ? previewError.message : "The generated PDF preview could not be rendered.");
        setLoading(false);
      }
    };

    loadPreview();
    return () => {
      active = false;
      controller.abort();
    };
  }, [result?.downloadUrl, result?.pageCount]);

  return <div className="pdf-result-preview-scroll" aria-label={`Preview of all ${totalPages || 0} output pages`}>
    {pages.map(({ pageNumber, source }) => <figure className="pdf-result-page" key={pageNumber}>
      <img src={source} alt={`Preview of page ${pageNumber} of ${result.filename}`} />
      <figcaption>Page {pageNumber}</figcaption>
    </figure>)}
    {loading && <div className="pdf-preview-progress"><LoaderCircle className="spin" size={18} /><span>Rendering page {Math.min(pages.length + 1, totalPages || pages.length + 1)} of {totalPages || "…"}</span></div>}
    {!loading && error && <DismissibleMessage className="preview-unavailable" resetKey={error}><AlertTriangle size={18} /><span>{error} Download the PDF to view it.</span></DismissibleMessage>}
    {!loading && !error && pages.length === 0 && <DismissibleMessage className="preview-unavailable" resetKey="no-preview-pages"><AlertTriangle size={18} /><span>No pages were available for preview. The PDF is ready to download.</span></DismissibleMessage>}
    {error && pages.length > 0 && <DismissibleMessage className="pdf-preview-error" resetKey={`${error}-${pages.length}`}><AlertTriangle size={16} /><span>Preview rendering stopped after {pages.length} of {totalPages} pages. The complete PDF is ready to download.</span></DismissibleMessage>}
  </div>;
}

function PdfJobCard({ job: initialJob, mode = "local", keepResult = false, replacementJobId = "", onReset, onContinue }) {
  const [job, setJob] = useState(initialJob);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const [filenameStemValue, setFilenameStemValue] = useState("");
  const trackedJobStatesRef = useRef(new Set());
  const cleanedReplacementJobRef = useRef("");
  useEffect(() => {
    if (mode !== "local" || !replacementJobId || job?.status !== "completed" || cleanedReplacementJobRef.current === job.id) return;
    cleanedReplacementJobRef.current = job.id;
    // Keep compatibility with older agents that ignore replaceJobId. On a
    // current agent this is an idempotent cleanup of the superseded row.
    deleteProcessingJob("local", replacementJobId).catch(() => undefined);
  }, [job?.id, job?.status, mode, replacementJobId]);
  useEffect(() => {
    // Browser jobs are completed in the parent because there is no server job
    // to poll. Keep the card in sync with that parent state so a successful
    // export cannot remain visually stuck on its last progress frame.
    if (mode === "browser") setJob(initialJob);
  }, [initialJob, mode]);
  useEffect(() => {
    if (mode === "browser") return undefined;
    let active = true;
    const poll = async () => {
      try {
        const current = await getProcessingJob(mode, initialJob.id);
        if (!active) return;
        const resultError = current.status === "completed" ? validatePdfResult(current.result) : "";
        setJob(resultError ? { ...current, status: "failed", error: `Export validation failed: ${resultError}` } : current);
        if (current.status === "queued" || current.status === "processing") window.setTimeout(poll, 1000);
      } catch (error) {
        if (active) setJob((current) => ({ ...current, status: "failed", error: error instanceof Error ? error.message : "Unable to read PDF job status." }));
      }
    };
    poll();
    return () => { active = false; };
  }, [initialJob.id, mode]);
  useEffect(() => {
    if (!job || !["completed", "failed"].includes(job.status)) return;
    const key = `pdf-editor:${job.id}:${job.status}`;
    if (trackedJobStatesRef.current.has(key)) return;
    trackedJobStatesRef.current.add(key);
    pushAnalyticsEvent(job.status === "completed" ? "processing_completed" : "processing_failed", job.status === "completed"
      ? { tool: "pdf-editor", mode, result_type: "pdf" }
      : { tool: "pdf-editor", mode, error_category: "export_failure" });
  }, [job, mode]);

  const printPdf = async () => {
    if (!job.result?.downloadUrl || printing) return;
    setPrinting(true);
    setPrintError("");
    let printWindow = null;
    let objectUrl = "";
    try {
      printWindow = window.open("about:blank", "_blank");
      if (!printWindow) throw new Error("Printing was blocked by the browser. Allow pop-ups for this site and try again.");
      printWindow.document.title = `Print ${job.result.filename || "PDF"}`;
      printWindow.document.body.innerHTML = "<p style=\"font:16px system-ui,sans-serif;padding:24px\">Preparing PDF for printing…</p>";
      const response = await fetch(job.result.downloadUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("The PDF could not be opened for printing. Download it and print the downloaded file instead.");
      const blob = await response.blob();
      objectUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
      printWindow.location.href = objectUrl;
      window.setTimeout(() => {
        if (printWindow && !printWindow.closed) {
          printWindow.focus();
          printWindow.print();
        }
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      }, 1500);
    } catch (error) {
      if (printWindow && !printWindow.closed) printWindow.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setPrintError(error instanceof Error ? error.message : "The PDF could not be opened for printing.");
    } finally {
      setPrinting(false);
    }
  };

  const done = job.status === "completed";
  const failed = job.status === "failed";
  const progress = Math.max(0, Math.min(100, job.progress || 0));
  const downloadName = done && job.result ? downloadFilename(filenameStemValue || filenameStem(job.result.filename), job.result.filename) : "";
  return <section className={`job-card pdf-job-card ${done ? "success" : failed ? "failed" : ""}`}><div className="job-topline"><span className="job-status-pill">{done ? <CheckCircle2 size={15} /> : failed ? <AlertTriangle size={15} /> : <LoaderCircle className="spin" size={15} />}{done ? "Complete" : failed ? "Needs attention" : job.status === "queued" ? "Queued" : "Processing"}</span><span className="job-id">Job {job.id.slice(0, 8)}</span></div><div className="job-icon">{done ? <CheckCircle2 size={30} /> : failed ? <AlertTriangle size={30} /> : <LoaderCircle className="spin" size={30} />}</div><h2>{done ? "Your edited PDF is ready" : failed ? "The PDF could not be created" : job.stage}</h2><p className="job-message">{failed ? job.error : job.message}</p>{!done && !failed && <><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="progress-meta"><span>{job.stage}</span><strong>{progress}%</strong></div></>}<div className="pdf-job-log"><div className="job-log-heading"><span>Worker log</span><span>{(job.logs || []).length} events</span></div><div className="job-log-list">{job.logs?.length ? job.logs.slice(-80).map((entry, index) => <div className={`job-log-entry ${entry.level === "error" ? "error" : ""}`} key={`${entry.time}-${index}`}><time>{new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span>{entry.message}</span></div>) : <div className="job-log-empty">Waiting for progress…</div>}</div></div>{job.warnings?.length > 0 && <div className="warning-list">{job.warnings.map((warning) => <DismissibleMessage key={warning} resetKey={warning}><AlertTriangle size={16} /><span>{warning}</span></DismissibleMessage>)}</div>}{done && job.result && <><div className="pdf-result-preview"><div className="preview-heading"><span>Edited PDF preview</span><small>All {job.result.pageCount || ""} pages</small></div><PdfResultPreview result={job.result} /></div><div className="result-summary"><div><span>Output</span><strong>{job.result.filename}</strong></div><div><span>Size</span><strong>{formatBytes(job.result.bytes)}</strong></div><div><span>Pages</span><strong>{job.result.pageCount}</strong></div><div><span>Method</span><strong>{job.result.method}</strong></div></div></>} {done && job.result && <ResultDownloadNote result={job.result} mode={mode} keepResult={keepResult} filename={downloadName} />} {done && job.result && <ResultFilenameField originalFilename={job.result.filename} value={filenameStemValue || filenameStem(job.result.filename)} onChange={setFilenameStemValue} />} {printError && <DismissibleMessage className="error-banner" resetKey={printError}><AlertTriangle size={17} /><span>{printError}</span></DismissibleMessage>}<div className="job-actions">{done && job.result && <><a className="primary-button" href={downloadUrlWithFilename(job.result.downloadUrl, downloadName)} download={downloadName} onClick={() => pushAnalyticsEvent("result_downloaded", { tool: "pdf-editor", result_type: "pdf" })}><Download size={18} /> Download PDF</a><button className="secondary-button" type="button" onClick={printPdf} disabled={printing}><Printer size={17} /> {printing ? "Preparing print…" : "Print PDF"}</button><button className="secondary-button" type="button" onClick={() => onContinue?.(job.result, job.id)}><FilePlus2 size={17} /> Continue editing</button></>}<button className="secondary-button" type="button" onClick={onReset}><RotateCcw size={17} /> {done || failed ? "Edit another PDF" : "Cancel"}</button></div></section>;
}
