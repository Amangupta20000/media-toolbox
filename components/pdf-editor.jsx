"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Download, FilePlus2, FileText, GripVertical, ImagePlus, Keyboard, LoaderCircle, Lock, MoreHorizontal, Plus, Printer, RotateCcw, RotateCw, Trash2, Unlock, UploadCloud, WandSparkles, X, ZoomIn, ZoomOut } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { formatBytes } from "./file-dropzone.jsx";
import { takeHistoryEdit } from "./history-edit.js";
import { ProcessingMode } from "./processing-mode.jsx";
import { ResultDownloadNote } from "./result-download-note.jsx";
import { ToolHistory, ToolViewTabs } from "./tool-history.jsx";
import { deleteProcessingJob, getProcessingJob, isProcessingLocationReady, probeProcessingLocations, uploadWithProgress } from "./processing-client.js";
import { MAX_PDF_COUNT, MAX_PDF_TOTAL_BYTES } from "../lib/pdf-limits.js";

const MAX_IMAGE_COORDINATE = 100000;
const ACCEPTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".heic", ".heif", ".tif", ".tiff", ".gif", ".bmp"]);
const A4 = { width: 595.28, height: 841.89, rotation: 0 };

function getPageImages(page) {
  if (Array.isArray(page?.images)) return page.images;
  return page?.image ? [{ ...page.image, id: page.image.id || "legacy-image" }] : [];
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
  if (processingMode !== "browser" && (!Array.isArray(pdfFiles) || pdfFiles.length === 0)) return "Add at least one PDF before exporting with Local agent or Server.";
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
      if (!values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0 || values[0] < -MAX_IMAGE_COORDINATE || values[1] < -MAX_IMAGE_COORDINATE || values[0] + values[2] > MAX_IMAGE_COORDINATE || values[1] + values[3] > MAX_IMAGE_COORDINATE) return `Image ${imageIndex + 1} on page ${index + 1} has an invalid placement.`;
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

async function loadPdfFile(file, pdfLibrary, { allowServerFallback = false } = {}) {
  const data = new Uint8Array(await file.arrayBuffer());
  let browserError = null;
  if (pdfLibrary) {
    try {
      const loaded = await loadPdfDocumentWithPassword(pdfLibrary, data, file.name);
      return { data, documentProxy: loaded.documentProxy, pageCount: loaded.documentProxy.numPages, fallbackDocument: null, pageSizes: null, serverFallback: false, passwordProtected: loaded.passwordProtected };
    } catch (error) {
      browserError = error;
    }
  }
  try {
    const { PDFDocument } = await import("pdf-lib");
    const fallbackDocument = await PDFDocument.load(data);
    let inspection = null;
    if (allowServerFallback) {
      try { inspection = await inspectPdfOnServer(file); } catch { /* the local fallback can still provide page metadata */ }
    }
    return { data, documentProxy: null, pageCount: fallbackDocument.getPageCount(), fallbackDocument, pageSizes: inspection?.pages || null, previewToken: inspection?.previewToken || null, serverFallback: false, passwordProtected: false };
  } catch (fallbackError) {
    if (!allowServerFallback) {
      const detail = fallbackError instanceof Error ? fallbackError.message : browserError?.message;
      throw new Error(detail ? `The PDF preview and editor parser could not read this PDF: ${detail}` : "This PDF could not be read. Choose Local agent or Server.");
    }
    try {
      const inspection = await inspectPdfOnServer(file);
      return { data, documentProxy: null, pageCount: inspection.pageCount, fallbackDocument: null, pageSizes: inspection.pages, previewToken: inspection.previewToken, serverFallback: true, passwordProtected: false };
    } catch (serverError) {
      const detail = serverError instanceof Error ? serverError.message : fallbackError instanceof Error ? fallbackError.message : browserError?.message;
      throw new Error(detail || "The browser and server PDF readers could not open this file.");
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

async function renderThumbnail(pdfDocument, pageNumber, rotation = 0) {
  const pdfPage = await pdfDocument.getPage(pageNumber);
  const dimensions = pageDimensions(pdfPage);
  const scale = Math.min(0.25, 124 / dimensions.height, 180 / dimensions.width);
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

async function renderPdfPageToJpeg(pdfPage) {
  const baseViewport = pdfPage.getViewport({ scale: 1, rotation: 0 });
  const scale = Math.min(1, 1200 / Math.max(1, baseViewport.width));
  const viewport = pdfPage.getViewport({ scale, rotation: 0 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  await withTimeout(pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise, 15000, "A PDF page took too long to render in Browser mode.");
  const blob = await withTimeout(new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92)), 30000, "The browser could not encode a PDF page.");
  if (!blob) throw new Error("The browser could not encode a PDF page.");
  return blob.arrayBuffer();
}

async function rasterizeBrowserPages(pages, sourceDocuments, preparedPages, onProgress) {
  const rasterPages = [];
  for (const [index, page] of pages.entries()) {
    const preparedPage = preparedPages[index];
    if (page.kind === "source") {
      const documentProxy = sourceDocuments?.[page.pdfIndex];
      if (!documentProxy) throw new Error("This PDF page cannot be rendered in Browser mode. Choose Local agent or Server for this file.");
      onProgress?.(17);
      const pdfPage = page.pdfPage || await withTimeout(documentProxy.getPage(page.pageIndex + 1), 60000, "A PDF page took too long to load in Browser mode.");
      onProgress?.(18);
      const bytes = await renderPdfPageToJpeg(pdfPage);
      rasterPages.push({ kind: "raster", width: page.width, height: page.height, rotation: page.rotation || 0, baseImage: { extension: ".jpg", bytes }, images: preparedPage.images || [] });
    } else {
      rasterPages.push({ kind: "blank", width: page.width, height: page.height, rotation: page.rotation || 0, images: preparedPage.images || [] });
    }
    onProgress?.(18 + Math.round(((index + 1) / Math.max(1, pages.length)) * 44));
  }
  return rasterPages;
}

async function exportPdfInBrowser(pdfFiles, pages, sourceDocuments, pdfLibrary, onProgress) {
  onProgress?.(1);
  for (const [index, record] of pdfFiles.entries()) {
    onProgress?.(Math.max(2, Math.round(((index + 1) / Math.max(1, pdfFiles.length)) * 8)));
  }

  const preparedPages = [];
  for (const [index, page] of pages.entries()) {
    const images = [];
    for (const image of getPageImages(page)) {
      const extension = fileExtension(image.file?.name);
      if (![".png", ".jpg", ".jpeg"].includes(extension)) throw new Error("Browser PDF mode supports PNG, JPG, and JPEG images. Choose Local agent or Server for HEIC and other image formats.");
      const bytes = image.sourceBytes
        ? image.sourceBytes.slice(0)
        : await withTimeout(image.file.arrayBuffer(), 30000, `Timed out while reading ${image.file.name}. Choose Local agent or Server for this file.`);
      images.push({ x: image.x, y: image.y, width: image.width, height: image.height, extension, bytes });
    }
    preparedPages.push({ kind: page.kind, pdfIndex: page.pdfIndex, pageIndex: page.pageIndex, width: page.width, height: page.height, rotation: page.rotation, images });
    onProgress?.(10 + Math.round(((index + 1) / Math.max(1, pages.length)) * 6));
  }

  onProgress?.(16);
  const rasterPages = await rasterizeBrowserPages(pages, sourceDocuments, preparedPages, onProgress);
  onProgress?.(64);
  const { PDFDocument, degrees } = await import("pdf-lib");
  const output = await PDFDocument.create();
  for (const [index, page] of rasterPages.entries()) {
    const target = output.addPage([page.width, page.height]);
    if (page.rotation) target.setRotation(degrees(page.rotation));
    if (page.baseImage) {
      const embeddedPage = await output.embedJpg(new Uint8Array(page.baseImage.bytes));
      target.drawImage(embeddedPage, { x: 0, y: 0, width: target.getWidth(), height: target.getHeight() });
    }
    for (const image of page.images || []) {
      const embedded = image.extension === ".png"
        ? await output.embedPng(new Uint8Array(image.bytes))
        : await output.embedJpg(new Uint8Array(image.bytes));
      target.drawImage(embedded, {
        x: image.x,
        y: target.getHeight() - image.y - image.height,
        width: image.width,
        height: image.height,
      });
    }
    onProgress?.(64 + Math.round(((index + 1) / Math.max(1, rasterPages.length)) * 8));
  }
  const bytes = new Uint8Array(await withTimeout(output.save(), 120000, "Browser PDF export took too long while saving the file. Try Local agent or Server for this file."));
  const previewImages = [];
  let previewError = null;
  if (pdfLibrary) {
    try {
      await withTimeout((async () => {
        const documentProxy = await pdfLibrary.getDocument({ data: bytes }).promise;
        for (let pageNumber = 1; pageNumber <= documentProxy.numPages; pageNumber += 1) {
          const pdfPage = await documentProxy.getPage(pageNumber);
          const viewport = pdfPage.getViewport({ scale: Math.min(1.1, 720 / pdfPage.getViewport({ scale: 1 }).width) });
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.ceil(viewport.width));
          canvas.height = Math.max(1, Math.ceil(viewport.height));
          await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          previewImages.push(canvas.toDataURL("image/jpeg", 0.84));
          onProgress?.(70 + Math.round((pageNumber / documentProxy.numPages) * 30));
        }
      })(), 120000, "The browser preview took too long to render.");
    } catch (error) {
      previewError = error instanceof Error ? error.message : "The output preview could not be rendered.";
    }
  }
  onProgress?.(100);
  const blob = new Blob([bytes], { type: "application/pdf" });
  const downloadUrl = URL.createObjectURL(blob);
  return { filename: pdfFiles.length === 1 ? `${pdfFiles[0].name.replace(/\.pdf$/i, "")}_edited.pdf` : "merged_edited.pdf", bytes: bytes.byteLength, pageCount: pages.length, method: "Browser PDF editor", downloadUrl, previewUrl: downloadUrl, previewImages, previewError };
}

export function PdfEditor() {
  const [pdfLibrary, setPdfLibrary] = useState(null);
  const [pdfFiles, setPdfFiles] = useState([]);
  const [pages, setPages] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draggedId, setDraggedId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);
  const [dropPosition, setDropPosition] = useState(null);
  const [recentlyDroppedId, setRecentlyDroppedId] = useState(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [pdfDragActive, setPdfDragActive] = useState(false);
  const [continuingFile, setContinuingFile] = useState(null);
  const [locations, setLocations] = useState(null);
  const [processingMode, setProcessingMode] = useState("local");
  const [jobMode, setJobMode] = useState("local");
  const [keepResult, setKeepResult] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [activeView, setActiveView] = useState("tool");
  const [moreToolsOpen, setMoreToolsOpen] = useState(false);
  const pdfInputRef = useRef(null);
  const imageInputRef = useRef(null);
  const pageListRef = useRef(null);
  const pageElementRefs = useRef(new Map());
  const previewScrollRef = useRef(null);
  const previewElementRefs = useRef(new Map());
  const dropAnimationTimerRef = useRef(null);
  const dragScrollFrameRef = useRef(null);
  const dragPointerRef = useRef({ x: 0, y: 0, forceBottom: false, forceRight: false });
  const imageTargetPageIdRef = useRef(null);
  const draggedIdRef = useRef(null);
  const dropIntentRef = useRef({ targetId: null, position: null });
  const documentsRef = useRef([]);
  const imageUrlsRef = useRef(new Set());
  const browserResultUrlRef = useRef("");
  const pdfLibraryPromiseRef = useRef(null);
  const historyEditLoadedRef = useRef(false);
  const moreToolsRef = useRef(null);

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

  useEffect(() => { probeProcessingLocations().then(setLocations).catch(() => undefined); }, []);

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

  useEffect(() => () => {
    for (const url of imageUrlsRef.current) URL.revokeObjectURL(url);
    if (dropAnimationTimerRef.current) window.clearTimeout(dropAnimationTimerRef.current);
    if (dragScrollFrameRef.current) window.cancelAnimationFrame(dragScrollFrameRef.current);
  }, []);

  const selectedPage = useMemo(() => pages.find((page) => page.id === selectedId) || pages[0] || null, [pages, selectedId]);
  const selectedPageImages = useMemo(() => getPageImages(selectedPage), [selectedPage]);

  useEffect(() => {
    if (!selectedPage) setMoreToolsOpen(false);
  }, [selectedPage]);

  const changePreviewZoom = (delta) => setPreviewZoom((current) => Math.min(3, Math.max(0.6, Math.round((current + delta) * 10) / 10)));
  const resetPreviewZoom = () => setPreviewZoom(1);

  const rotateSelectedPage = (delta) => {
    if (!selectedPage) return;
    updatePage(selectedPage.id, { rotation: normalizeRotation((selectedPage.rotation || 0) + delta) });
    setError("");
  };

  const duplicateSelectedPage = async () => {
    if (!selectedPage) return;
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
    const duplicate = { ...selectedPage, id: makeId(), images: clonedImages };
    setPages((current) => {
      const selectedIndex = current.findIndex((page) => page.id === selectedPage.id);
      const next = [...current];
      next.splice(selectedIndex >= 0 ? selectedIndex + 1 : next.length, 0, duplicate);
      return next;
    });
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
    if (existingPdfBytes + selectedPdfBytes > MAX_PDF_TOTAL_BYTES) {
      setError("The combined PDF upload must be 200 MB or smaller. Remove a PDF before adding another.");
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
      let pdfIndex = pdfFiles.length;
      const newFiles = [];
      const newPages = [];
      let thumbnailFailures = 0;
      let browserFallbacks = 0;
      let serverFallbacks = 0;
      let passwordProtectedFiles = 0;
      for (const file of selectedFiles) {
      const loaded = await loadPdfFile(file, activePdfLibrary, { allowServerFallback: processingMode === "server" });
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
      setPdfFiles((current) => [...current, ...newFiles]);
      setPages((current) => {
        const next = [...current, ...newPages];
        if (!selectedId && next[0]) setSelectedId(next[0].id);
        return next;
      });
      if (browserFallbacks || serverFallbacks || thumbnailFailures || passwordProtectedFiles) {
        const messages = [];
        if (browserFallbacks) messages.push("PDF preview was unavailable, so a safe PDF parser was used");
        if (serverFallbacks) messages.push("The browser used the server PDF reader to validate the document");
        if (thumbnailFailures) messages.push(`${thumbnailFailures} page preview${thumbnailFailures === 1 ? "" : "s"} could not be rendered`);
        if (passwordProtectedFiles) messages.push(`${passwordProtectedFiles} password-protected PDF${passwordProtectedFiles === 1 ? " was" : "s were"} opened with the supplied password and will be safely flattened during export`);
        setPreviewError(`${messages.join("; ")}. The PDF can still be edited and exported.`);
      }
    } catch (loadError) {
      const detail = loadError instanceof Error ? loadError.message : "";
      console.error("PDF editor import failed", loadError);
      setError(/password|encrypt/i.test(detail) ? "The PDF could not be opened. Check the password and try again." : detail ? `PDF import failed: ${detail.slice(0, 240)}` : "The browser and server PDF readers could not open this file.");
    } finally {
      setLoadingFiles(false);
    }
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
      if (active) setContinuingFile(new File([blob], pending.filename || "saved.pdf", { type: "application/pdf" }));
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
    addPdfFiles(event.dataTransfer.files);
  };

  const updatePage = (pageId, changes) => setPages((current) => current.map((page) => page.id === pageId ? { ...page, ...changes } : page));

  const addBlankPage = () => {
    const dimensions = selectedPage ? { width: selectedPage.width, height: selectedPage.height, rotation: selectedPage.rotation || 0 } : A4;
    const page = { id: makeId(), kind: "blank", ...dimensions, images: [] };
    setPages((current) => {
      const selectedIndex = selectedPage ? current.findIndex((item) => item.id === selectedPage.id) : -1;
      const next = [...current];
      next.splice(selectedIndex >= 0 ? selectedIndex + 1 : next.length, 0, page);
      return next;
    });
    setSelectedId(page.id);
    setError("");
  };

  const addBlankPageAfter = (previousPageId) => {
    const previousPage = pages.find((item) => item.id === previousPageId);
    const dimensions = previousPage ? { width: previousPage.width, height: previousPage.height, rotation: previousPage.rotation || 0 } : A4;
    const page = { id: makeId(), kind: "blank", ...dimensions, images: [] };
    setPages((current) => {
      const previousIndex = current.findIndex((item) => item.id === previousPageId);
      const next = [...current];
      next.splice(previousIndex >= 0 ? previousIndex + 1 : next.length, 0, page);
      return next;
    });
    setSelectedId(page.id);
    setError("");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      scrollPreviewIntoView(page.id);
      scrollThumbnailIntoView(page.id);
    }));
  };

  const deletePage = (pageId) => {
    setPages((current) => {
      const index = current.findIndex((page) => page.id === pageId);
      const next = current.filter((page) => page.id !== pageId);
      for (const image of getPageImages(current[index])) {
        if (image.url) { URL.revokeObjectURL(image.url); imageUrlsRef.current.delete(image.url); }
      }
      if (pageId === selectedId) setSelectedId(next[Math.min(index, next.length - 1)]?.id || null);
      return next;
    });
  };

  const reorderPages = (sourceId, targetId, position = "before") => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const beforeRects = new Map();
    for (const [pageId, element] of pageElementRefs.current.entries()) beforeRects.set(pageId, element.getBoundingClientRect());
    setPages((current) => {
      const sourceIndex = current.findIndex((page) => page.id === sourceId);
      const targetIndex = current.findIndex((page) => page.id === targetId);
      if (sourceIndex === -1 || targetIndex === -1) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      let insertionIndex = targetIndex + (position === "after" ? 1 : 0);
      if (sourceIndex < insertionIndex) insertionIndex -= 1;
      next.splice(insertionIndex, 0, moved);
      return next;
    });
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
      const { x, y, forceBottom, forceRight } = dragPointerRef.current;
      const edge = 116;
      let moved = false;
      if (list.scrollHeight > list.clientHeight) {
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
      if (list.scrollWidth > list.clientWidth) {
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
      if (moved && draggedIdRef.current) dragScrollFrameRef.current = window.requestAnimationFrame(tick);
    };
    dragScrollFrameRef.current = window.requestAnimationFrame(tick);
  };

  const handlePageListDragOver = (event) => {
    event.preventDefault();
    if (!draggedIdRef.current) return;
    dragPointerRef.current = { ...dragPointerRef.current, x: event.clientX, y: event.clientY };
    startPageListAutoScroll();
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
    dragPointerRef.current = { x: event.clientX, y: event.clientY, forceBottom, forceRight };
    startPageListAutoScroll();
    if (activeDraggedId === pageId) {
      clearDropIntent();
      return;
    }
    const position = event.clientY < targetBounds.top + targetBounds.height / 2 ? "before" : "after";
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
    const pointerPosition = event.currentTarget?.getBoundingClientRect ? (event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2 ? "before" : "after") : null;
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

  const startDraggingPage = (pageId) => {
    draggedIdRef.current = pageId;
    dragPointerRef.current = { x: 0, y: 0, forceBottom: false, forceRight: false };
    dropIntentRef.current = { targetId: null, position: null };
    setDraggedId(pageId);
    setDropTargetId(null);
    setDropPosition(null);
  };

  const resetDragState = () => {
    stopPageListAutoScroll();
    draggedIdRef.current = null;
    clearDropIntent();
    setDraggedId(null);
  };

  const renderPageList = () => {
    return pages.map((page, index) => <PdfPageThumbnail key={page.id} page={page} index={index} elementRef={(element) => { if (element) pageElementRefs.current.set(page.id, element); else pageElementRefs.current.delete(page.id); }} thumbnailRootRef={pageListRef} pdfDocument={page.kind === "source" ? documentsRef.current[page.pdfIndex] : null} onThumbnailError={() => setPreviewError("Some thumbnails could not be rendered, but the pages remain available in the full preview.")} selected={page.id === selectedPage?.id} draggedId={draggedId} dropTargetId={dropTargetId} dropPosition={dropPosition} recentlyDroppedId={recentlyDroppedId} onSelect={() => selectPage(page.id)} onDelete={() => deletePage(page.id)} onDragStart={() => startDraggingPage(page.id)} onDragEnd={resetDragState} onDragOver={(event) => handlePageDragOver(event, page.id)} onDrop={(event) => handlePageDrop(event, page.id)} />);
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

  const selectPage = (pageId) => {
    setSelectedId(pageId);
    scrollThumbnailIntoView(pageId);
    window.requestAnimationFrame(() => scrollPreviewIntoView(pageId));
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
    if (bestPage && bestPage.id !== selectedId) {
      setSelectedId(bestPage.id);
      window.requestAnimationFrame(() => scrollThumbnailIntoView(bestPage.id));
    }
  };

  const addImages = async (fileList, targetPageId = selectedPage?.id) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length) return;
    const targetPage = pages.find((page) => page.id === targetPageId) || selectedPage;
    if (!targetPage) { setError("Select a PDF page before adding images."); return; }
    for (const file of files) {
      if (!isImage(file)) { setError(`${file.name} is not a supported image. Choose PNG, JPG, JPEG, HEIC, TIFF, GIF, or BMP.`); return; }
      if (file.size > 25 * 1024 * 1024) { setError(`${file.name} is larger than the 25 MB image limit.`); return; }
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
        addedImages.push({ id: makeId(), file, sourceBytes: await file.arrayBuffer(), url, x, y, width, height, lockAspectRatio: true });
      }
      updatePage(targetPage.id, { images: [...existingImages, ...addedImages] });
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
    const page = pages.find((item) => item.id === pageId);
    const images = getPageImages(page);
    const image = images.find((item) => item.id === imageId);
    if (image?.url) {
      URL.revokeObjectURL(image.url);
      imageUrlsRef.current.delete(image.url);
    }
    updatePage(pageId, { images: images.filter((item) => item.id !== imageId) });
  };

  const removeAllImages = (pageId) => {
    const page = pages.find((item) => item.id === pageId);
    for (const image of getPageImages(page)) {
      if (image.url) {
        URL.revokeObjectURL(image.url);
        imageUrlsRef.current.delete(image.url);
      }
    }
    updatePage(pageId, { images: [] });
  };

  const reset = () => {
    if (job && jobMode !== "browser" && (job.status === "queued" || job.status === "processing")) deleteProcessingJob(jobMode, job.id).catch(() => undefined);
    for (const page of pages) for (const image of getPageImages(page)) if (image.url) { URL.revokeObjectURL(image.url); imageUrlsRef.current.delete(image.url); }
    documentsRef.current = [];
    if (browserResultUrlRef.current) URL.revokeObjectURL(browserResultUrlRef.current);
    browserResultUrlRef.current = "";
    setPdfFiles([]); setPages([]); setSelectedId(null); setJob(null); setContinuingFile(null); setError(""); setPreviewError(""); setUploadProgress(0);
  };

  const continueEditing = async (result) => {
    if (!result?.downloadUrl) { setError("The generated PDF is no longer available for editing."); return; }
    try {
      const response = await fetch(result.downloadUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("The generated PDF could not be reopened.");
      const file = new File([await response.blob()], result.filename || "edited.pdf", { type: "application/pdf" });
      for (const page of pages) for (const image of getPageImages(page)) if (image.url) { URL.revokeObjectURL(image.url); imageUrlsRef.current.delete(image.url); }
      documentsRef.current = [];
      if (browserResultUrlRef.current) URL.revokeObjectURL(browserResultUrlRef.current);
      browserResultUrlRef.current = "";
      setPdfFiles([]); setPages([]); setSelectedId(null); setJob(null); setError(""); setPreviewError(""); setUploadProgress(0);
      setContinuingFile(file);
    } catch (continueError) {
      setError(continueError instanceof Error ? continueError.message : "The generated PDF could not be reopened.");
    }
  };

  const submit = async () => {
    const validationError = validatePdfProject({ pages, pdfFiles, processingMode });
    if (validationError) { setError(`Export validation failed: ${validationError}`); return; }
    if (processingMode === "browser") {
      setProcessingMode("local");
      setError("Browser mode is temporarily unavailable. Choose Local agent or Server.");
      return;
    }
    if (processingMode !== "browser" && !pdfFiles.length) { setError("Add at least one PDF before exporting with Local agent or Server."); return; }
    if (processingMode !== "browser" && !isProcessingLocationReady(locations, processingMode)) { setError(processingMode === "local" ? "Admin login or activation is required in the Local agent dashboard." : "Server processing is unavailable."); return; }
    setError("");
    setJobMode(processingMode);
    if (processingMode === "browser") {
      try {
        const activePdfLibrary = pdfLibrary || await ensurePdfLibrary();
        if (!pdfLibrary) setPdfLibrary(activePdfLibrary);
        const browserId = `browser-${makeId()}`;
        setJob({ id: browserId, status: "processing", progress: 0, stage: "Creating PDF in this browser", message: "The source PDFs are staying in this browser.", logs: [{ time: new Date().toISOString(), level: "info", message: "Browser PDF export started." }], warnings: [], error: null, result: null });
        const result = await exportPdfInBrowser(pdfFiles, pages, documentsRef.current, activePdfLibrary, (progress) => setJob((current) => current ? { ...current, progress, stage: progress < 15 ? "Loading source PDFs" : progress < 70 ? "Copying and arranging pages" : progress < 75 ? "Creating final PDF" : "Rendering output preview", logs: [...(current.logs || []), { time: new Date().toISOString(), level: "info", message: `Browser export progress: ${progress}%.` }] } : current));
        browserResultUrlRef.current = result.downloadUrl;
        setJob((current) => current ? { ...current, status: "completed", progress: 100, stage: "Complete", message: result.previewError ? "The PDF was created in this browser. Its download is ready; the on-page preview could not be rendered." : "The PDF was created in this browser.", logs: [...(current.logs || []), ...(result.previewError ? [{ time: new Date().toISOString(), level: "warn", message: "The PDF was created successfully, but the browser preview could not be rendered." }] : []), { time: new Date().toISOString(), level: "info", message: "Browser PDF export completed." }], result } : current);
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
            return { imageField, image: { x: image.x, y: image.y, width: image.width, height: image.height } };
          });
        }
        return operation;
      }));
    } catch (operationError) {
      setError(operationError instanceof Error ? operationError.message : "A PDF page could not be prepared for export.");
      return;
    }
    form.append("operations", JSON.stringify(operations));
    if (processingMode === "local") form.append("retention", keepResult ? "keep" : "delete");
    try {
      setUploadProgress(1);
      const response = await uploadWithProgress(form, processingMode, setUploadProgress);
      setUploadProgress(0);
      setJob({ id: response.jobId, status: "queued", progress: 0, stage: "Queued", message: "Waiting for the worker.", logs: [], warnings: [], error: null, result: null });
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
      if (command && event.key.toLowerCase() === "d") {
        event.preventDefault();
        void duplicateSelectedPage();
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
  }, [activeView, job, loadingFiles, selectedPage, previewZoom, pages, pdfFiles, processingMode]);

  return <AppShell>
    <div className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> PDF tools · Beta <span className="pdf-capacity-note"><FileText size={14} /> Up to 5 PDFs · 200 MB total</span></div><h1>PDF editor</h1><p>Merge documents, reorder pages, remove pages, and add images to PDF pages or new blank pages.</p></div></div>
    <ToolViewTabs value={activeView} onChange={setActiveView} />
    {activeView === "history" ? <ToolHistory tool="pdf-editor" /> : <>
    {!job && <ProcessingMode value={processingMode} onChange={setProcessingMode} locations={locations} />}
    {job ? <PdfJobCard job={job} mode={jobMode} keepResult={keepResult} onReset={reset} onContinue={continueEditing} /> : <section className={`pdf-editor-shell ${pdfDragActive ? "pdf-drop-active" : ""}`} onDragOver={handlePdfDragOver} onDragLeave={handlePdfDragLeave} onDrop={handlePdfDrop}>
      <div className="pdf-editor-toolbar">
        <div className="pdf-editor-toolbar-heading"><strong>Build your document</strong><span>{pdfFiles.length} of {MAX_PDF_COUNT} PDFs · {pages.length} pages · {Math.ceil(pdfFiles.reduce((total, record) => total + Number(record.file?.size || 0), 0) / (1024 * 1024)) || 0} MB of 200 MB</span></div>
        <div className="pdf-editor-actions">
          <button className="secondary-button" type="button" onClick={() => pdfInputRef.current?.click()} disabled={loadingFiles || pdfFiles.length >= MAX_PDF_COUNT}><Plus size={17} /> Add PDF</button>
          <button className="secondary-button" type="button" onClick={addBlankPage}><FilePlus2 size={17} /> Blank page</button>
          <div ref={moreToolsRef} className="pdf-more-tools">
            <button className="icon-button pdf-more-tools-trigger" type="button" aria-label="Open other PDF tools" aria-haspopup="menu" aria-expanded={Boolean(selectedPage) && moreToolsOpen} title={selectedPage ? "Other tools" : "Add a page to use other tools"} disabled={!selectedPage} onClick={() => setMoreToolsOpen((current) => !current)}><MoreHorizontal size={20} /></button>
            {selectedPage && moreToolsOpen && <div className="pdf-more-tools-menu" role="menu" aria-label="Other PDF tools">
              <div className="pdf-more-tools-heading">Page tools</div>
              <button type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); rotateSelectedPage(-90); }}><RotateCcw size={16} /><span>Rotate left</span><kbd>←</kbd></button>
              <button type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); rotateSelectedPage(90); }}><RotateCw size={16} /><span>Rotate right</span><kbd>→</kbd></button>
              <button type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); void duplicateSelectedPage(); }}><Copy size={16} /><span>Duplicate page</span><kbd>⌘/Ctrl+D</kbd></button>
              <button type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); imageInputRef.current?.click(); }}><ImagePlus size={16} /><span>Add images</span></button>
              {selectedPageImages.length > 0 && <button type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); removeAllImages(selectedPage.id); }}><Trash2 size={16} /><span>Remove images</span></button>}
              <div className="pdf-more-tools-divider" />
              <button className="pdf-more-tools-danger" type="button" role="menuitem" onClick={() => { setMoreToolsOpen(false); deletePage(selectedPage.id); }}><Trash2 size={16} /><span>Delete page</span><kbd>Delete</kbd></button>
            </div>}
          </div>
          <div className="pdf-zoom-controls" aria-label="Preview zoom"><button className="icon-button" type="button" onClick={() => changePreviewZoom(-0.1)} aria-label="Zoom out" title="Zoom out (-)"><ZoomOut size={16} /></button><button className="pdf-zoom-value" type="button" onClick={resetPreviewZoom} title="Reset zoom (0)">{Math.round(previewZoom * 100)}%</button><button className="icon-button" type="button" onClick={() => changePreviewZoom(0.1)} aria-label="Zoom in" title="Zoom in (+)"><ZoomIn size={16} /></button></div>
          <button className="primary-button" type="button" onClick={submit} disabled={!pages.length || Boolean(uploadProgress) || loadingFiles}><WandSparkles size={17} /> {uploadProgress ? `Uploading ${uploadProgress}%` : "Export PDF"}</button>
        </div>
        <div className="pdf-shortcuts"><Keyboard size={14} /> ←/→ rotate · ⌘/Ctrl+D duplicate · Delete remove · +/- zoom · ⌘/Ctrl+Enter export</div>
      </div>
      <input ref={pdfInputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={(event) => { addPdfFiles(event.target.files); event.target.value = ""; }} />
      <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/heic,image/heif,image/tiff,image/gif,image/bmp,.png,.jpg,.jpeg,.heic,.heif,.tif,.tiff,.gif,.bmp" multiple hidden onChange={(event) => { const targetPageId = imageTargetPageIdRef.current; imageTargetPageIdRef.current = null; addImages(event.target.files, targetPageId || undefined); event.target.value = ""; }} />
      {processingMode === "local" && <label className="keep-result-check pdf-retention-check"><input type="checkbox" checked={keepResult} onChange={(event) => setKeepResult(event.target.checked)} /><span>Keep final result on this device</span></label>}
      {!pdfFiles.length && !pages.length ? <PdfEmptyState onBrowse={() => pdfInputRef.current?.click()} loading={loadingFiles} dragActive={pdfDragActive} /> : !pages.length ? <PdfNoPagesState onBrowse={() => pdfInputRef.current?.click()} onBlank={addBlankPage} /> : <div className="pdf-editor-layout">
        <aside className="pdf-page-rail"><div className="pdf-rail-heading"><span>Pages</span><small>Pages load as you scroll</small></div><div ref={pageListRef} className="pdf-page-list" onDragOver={handlePageListDragOver} onDrop={handlePageListDrop}>{renderPageList()}</div></aside>
        <section className="pdf-selected-panel"><div className="pdf-selected-heading"><div><span>Selected page {selectedPage ? pages.findIndex((page) => page.id === selectedPage.id) + 1 : "—"}</span><small>{selectedPage?.kind === "blank" ? "Blank page" : selectedPage?.sourceName || "Choose a page"}{selectedPage?.kind === "source" ? ` · Original page ${selectedPage.pageNumber}` : ""}</small></div></div><div ref={previewScrollRef} className="pdf-document-preview" onScroll={handlePreviewScroll}>{pages.map((page, index) => <Fragment key={page.id}><PdfPreviewPage page={page} index={index} selected={page.id === selectedPage?.id} previewZoom={previewZoom} pdfDocument={documentsRef.current[page.pdfIndex]} previewRootRef={previewScrollRef} elementRef={(element) => { if (element) previewElementRefs.current.set(page.id, element); else previewElementRefs.current.delete(page.id); }} onChange={(images) => updatePage(page.id, { images })} onRemove={(imageId) => removeImage(page.id, imageId)} onAddImages={() => openImagePickerForPage(page.id)} onError={setPreviewError} /><PdfInsertPageButton pageNumber={index + 1} onClick={() => addBlankPageAfter(page.id)} /></Fragment>)}</div>{previewError && <div className="pdf-preview-error"><AlertTriangle size={16} /><span>{previewError}</span></div>}<p className="pdf-editor-tip"><GripVertical size={15} /> Scroll the preview to select a page. Click + Add page between previews to insert a blank page.</p></section>
      </div>}
      {error && <div className="error-banner"><AlertTriangle size={18} /><span>{error}</span></div>}
    </section>}
    </>}
  </AppShell>;
}

function PdfEmptyState({ onBrowse, loading, dragActive }) {
  return <div className="pdf-empty-state"><div className="pdf-empty-icon"><UploadCloud size={28} /></div><h2>{loading ? "Reading PDF pages…" : dragActive ? "Drop your PDF files" : "Add your first PDF"}</h2><p>{loading ? "Creating page previews for the editor." : dragActive ? "Release to add the PDFs to your project." : "Upload one PDF to edit it, or add up to five PDFs to merge them."}</p><button className="primary-button" type="button" onClick={onBrowse} disabled={loading}><FilePlus2 size={18} /> Browse PDF files</button><small>Up to 5 PDFs · 200 MB total</small></div>;
}

function PdfNoPagesState({ onBrowse, onBlank }) {
  return <div className="pdf-empty-state pdf-no-pages-state"><div className="pdf-empty-icon"><FileText size={28} /></div><h2>No pages left</h2><p>Add another PDF or add a blank page to continue building your document.</p><div className="pdf-empty-actions"><button className="primary-button" type="button" onClick={onBrowse}><Plus size={18} /> Add PDF</button><button className="secondary-button" type="button" onClick={onBlank}><FilePlus2 size={18} /> Add blank page</button></div></div>;
}

function PdfPreviewPage({ page, index, selected, previewZoom, pdfDocument, previewRootRef, elementRef, onChange, onRemove, onAddImages, onError }) {
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
    {shouldRender ? page.kind === "blank" ? <BlankPageCanvas page={page} onChange={onChange} onRemove={onRemove} onAddImages={onAddImages} /> : page.previewFallback ? <PdfFallbackPreview page={page} compact onChange={onChange} onRemove={onRemove} /> : <PdfPageCanvas page={page} pdfDocument={pdfDocument} pageNumber={page.pageNumber} previewZoom={previewZoom} onError={onError} onChange={onChange} onRemove={onRemove} /> : <div className="pdf-preview-page-placeholder" style={{ "--page-ratio": pageDisplayRatio(page) }}><FileText size={24} /><span>Loading page {index + 1}</span></div>}
  </article>;
}

function PdfInsertPageButton({ pageNumber, onClick }) {
  return <div className="pdf-insert-page"><span className="pdf-insert-page-line" /><button className="pdf-insert-page-button" type="button" onClick={onClick} aria-label={`Add a blank page after page ${pageNumber}`} title={`Add a blank page after page ${pageNumber}`}><Plus size={17} /><span>Add page</span></button><span className="pdf-insert-page-line" /></div>;
}

function PdfPageThumbnail({ page, index, elementRef, thumbnailRootRef, pdfDocument, onThumbnailError, selected, draggedId, dropTargetId, dropPosition, recentlyDroppedId, onSelect, onDelete, onDragStart, onDragEnd, onDragOver, onDrop }) {
  return <>{dropTargetId === page.id && dropPosition === "before" && <div className="pdf-drop-gap" aria-hidden="true">Drop here</div>}<div ref={elementRef} className={`pdf-page-thumbnail ${selected ? "selected" : ""} ${draggedId === page.id ? "dragging" : ""} ${dropTargetId === page.id ? "drop-target" : ""} ${recentlyDroppedId === page.id && draggedId !== page.id ? "just-dropped" : ""}`} draggable onClick={onSelect} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver} onDrop={onDrop}>
    <div className="thumbnail-frame">{page.kind === "source" || page.kind === "raster" ? <div className="thumbnail-page-surface" style={{ "--page-ratio": pageDisplayRatio(page) }}><PdfThumbnailImage page={page} index={index} pdfDocument={pdfDocument} rootRef={thumbnailRootRef} onError={onThumbnailError} /><ThumbnailImageOverlayLayer page={page} /></div> : <BlankPageMiniature page={page} />}</div>
    <div className="thumbnail-meta"><GripVertical className="thumbnail-grip" size={14} /><span><strong>Final {index + 1}</strong>{page.kind === "source" || page.kind === "raster" ? <> · <span className="thumbnail-original-page">Original {page.pageNumber}</span> · {page.sourceName}</> : " · New blank page"}</span><button type="button" aria-label={`Delete page ${index + 1}`} title="Delete page" onClick={(event) => { event.stopPropagation(); onDelete(); }}><X size={14} /></button></div>
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
  return <img ref={frameRef} className="thumbnail-page-image" src={thumbnail} alt={`Page ${index + 1}`} loading={index < 4 ? "eager" : "lazy"} decoding="async" style={page.previewFallback ? { transform: `rotate(${normalizeRotation(page.rotation)}deg)` } : undefined} />;
}

function ThumbnailImageOverlayLayer({ page }) {
  return <div className="thumbnail-image-overlay-layer">{getPageImages(page).map((image, index) => { const placement = imageDisplayPlacement(page, image); return <img key={image.id || index} src={image.url} alt="" aria-hidden="true" style={{ left: `${placement.x / placement.pageWidth * 100}%`, top: `${placement.y / placement.pageHeight * 100}%`, width: `${placement.width / placement.pageWidth * 100}%`, height: `${placement.height / placement.pageHeight * 100}%` }} />; })}</div>;
}

function BlankPageMiniature({ page }) {
  const images = getPageImages(page);
  return <div className="blank-page-mini" style={{ aspectRatio: pageDisplayRatio(page) }}>{images.map((image, index) => { const placement = imageDisplayPlacement(page, image); return <img key={image.id || index} src={image.url} alt={`Image ${index + 1} on blank page`} style={{ left: `${placement.x / placement.pageWidth * 100}%`, top: `${placement.y / placement.pageHeight * 100}%`, width: `${placement.width / placement.pageWidth * 100}%`, height: `${placement.height / placement.pageHeight * 100}%` }} />; })}</div>;
}

function PdfPageCanvas({ page, pdfDocument, pageNumber, previewZoom = 1, onError, onChange, onRemove }) {
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
      const availableWidth = Math.max(1, frame.clientWidth - 36);
      const availableHeight = Math.max(1, frame.clientHeight - 36);
      const fitScale = Math.min(availableWidth / baseViewport.width, availableHeight / baseViewport.height);
      // Zoom is applied to the actual page dimensions, not only to the
      // surrounding card. Once the page exceeds the frame, the frame scrolls.
      const scale = Math.min(1.35, Math.max(0.45, fitScale)) * previewZoom;
      // Keep the displayed page at the same CSS size, but render its backing
      // canvas at 2x (or the display's native density) so text and vector
      // artwork stay sharp in the full preview. Thumbnails intentionally use
      // their smaller render path.
      const pixelRatio = Math.min(3, Math.max(2, Number(window.devicePixelRatio) || 1));
      const displayViewport = pageInfo.pdfPage.getViewport({ scale, rotation });
      setSurfaceSize({ width: displayViewport.width, height: displayViewport.height });
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
  return <div ref={frameRef} className="pdf-page-canvas-wrap"><div ref={surfaceRef} className="pdf-page-canvas-surface" style={{ "--page-ratio": ratio, ...(surfaceSize ? { width: `${surfaceSize.width}px`, height: `${surfaceSize.height}px` } : {}) }}><canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} /><ImageOverlayLayer page={page} onChange={onChange} onRemove={onRemove} /></div></div>;
}

function PdfFallbackPreview({ page, compact = false, onChange, onRemove }) {
  const previewUrl = page.previewToken ? `/api/pdf/preview?token=${encodeURIComponent(page.previewToken)}&page=${page.pageNumber}` : "";
  return <div className="pdf-page-fallback"><div className="pdf-page-fallback-stage" style={{ "--page-ratio": pageDisplayRatio(page) }}>{previewUrl ? <img src={previewUrl} alt={`Preview of PDF page ${page.pageNumber}`} style={{ transform: `rotate(${normalizeRotation(page.rotation)}deg)` }} /> : <div className="pdf-page-fallback-empty"><FileText size={28} /><strong>Preview is unavailable</strong></div>}<ImageOverlayLayer page={page} onChange={onChange} onRemove={onRemove} /></div>{!compact && <div className="pdf-page-fallback-note"><FileText size={22} /><strong>Server-rendered PDF preview</strong><span>Page {page.pageNumber} is ready to include in the exported PDF.</span></div>}</div>;
}

function BlankPageCanvas({ page, onChange, onRemove, onAddImages }) {
  const images = getPageImages(page);
  return <div className="blank-page-preview-area"><div className="blank-page-canvas" style={{ "--page-ratio": pageDisplayRatio(page) }}>{images.length ? <ImageOverlayLayer page={page} onChange={onChange} onRemove={onRemove} /> : <button className="blank-page-message" type="button" onClick={onAddImages}><ImagePlus size={25} /><span>Add images to this blank page</span></button>}</div><p className="blank-page-help">{images.length ? "Drag an image to move it. Use the corner handle to resize it. Use the lock to allow free resizing. Use × to remove it." : "Click the blank page to add one or more supported images."}</p></div>;
}

function ImageOverlayLayer({ page, onChange, onRemove }) {
  const layerRef = useRef(null);
  const interactionRef = useRef(null);
  const images = getPageImages(page);

  const onPointerDown = (event, mode, image) => {
    if (!image || !layerRef.current) return;
    const bounds = layerRef.current.getBoundingClientRect();
    interactionRef.current = { mode, imageId: image.id, startX: event.clientX, startY: event.clientY, bounds, image: { ...image } };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event) => {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const image = images.find((item) => item.id === interaction.imageId);
    if (!image) return;
    const displayDimensions = pageDisplayDimensions(page);
    const displayDx = (event.clientX - interaction.startX) * displayDimensions.width / interaction.bounds.width;
    const displayDy = (event.clientY - interaction.startY) * displayDimensions.height / interaction.bounds.height;
    const rotation = normalizeRotation(page.rotation);
    const dx = rotation === 90 ? displayDy : rotation === 180 ? -displayDx : rotation === 270 ? -displayDy : displayDx;
    const dy = rotation === 90 ? -displayDx : rotation === 180 ? -displayDy : rotation === 270 ? displayDx : displayDy;
    if (interaction.mode === "move") {
      onChange(images.map((item) => item.id === interaction.imageId ? { ...item, x: Math.max(-MAX_IMAGE_COORDINATE, Math.min(MAX_IMAGE_COORDINATE - item.width, interaction.image.x + dx)), y: Math.max(-MAX_IMAGE_COORDINATE, Math.min(MAX_IMAGE_COORDINATE - item.height, interaction.image.y + dy)) } : item));
    } else {
      const widthDelta = rotation === 90 || rotation === 270 ? displayDy : displayDx;
      const heightDelta = rotation === 90 || rotation === 270 ? displayDx : displayDy;
      const width = Math.max(24, Math.min(MAX_IMAGE_COORDINATE, interaction.image.width + widthDelta));
      const ratio = interaction.image.height / interaction.image.width;
      const height = interaction.image.lockAspectRatio === false
        ? Math.max(24, Math.min(MAX_IMAGE_COORDINATE, interaction.image.height + heightDelta))
        : Math.max(24, Math.min(MAX_IMAGE_COORDINATE, width * ratio));
      onChange(images.map((item) => item.id === interaction.imageId ? { ...item, width, height } : item));
    }
  };
  const onPointerUp = () => { interactionRef.current = null; };
  const toggleAspectRatio = (imageId) => onChange(images.map((item) => item.id === imageId ? { ...item, lockAspectRatio: item.lockAspectRatio === false } : item));

  return <div ref={layerRef} className="pdf-image-overlay-layer" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>{images.map((image, index) => { const placement = imageDisplayPlacement(page, image); return <div className="pdf-image-overlay" key={image.id || index} style={{ left: `${placement.x / placement.pageWidth * 100}%`, top: `${placement.y / placement.pageHeight * 100}%`, width: `${placement.width / placement.pageWidth * 100}%`, height: `${placement.height / placement.pageHeight * 100}%`, zIndex: index + 1 }} onPointerDown={(event) => onPointerDown(event, "move", image)}><img src={image.url} alt={`Placed image ${index + 1}`} draggable="false" /><button type="button" className="image-remove-handle" aria-label={`Remove image ${index + 1}`} title="Remove image" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onRemove?.(image.id); }}><X size={11} /></button><button type="button" className="image-ratio-handle" aria-label={image.lockAspectRatio === false ? `Keep image ${index + 1} aspect ratio` : `Allow image ${index + 1} free resizing`} title={image.lockAspectRatio === false ? "Keep aspect ratio" : "Allow free resizing"} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); toggleAspectRatio(image.id); }}>{image.lockAspectRatio === false ? <Unlock size={10} /> : <Lock size={10} />}</button><button type="button" className="image-resize-handle" aria-label={`Resize image ${index + 1}`} onPointerDown={(event) => { event.stopPropagation(); onPointerDown(event, "resize", image); }} /></div>; })}</div>;
}

function pdfPreviewUrl(downloadUrl) {
  if (!downloadUrl) return "";
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
        const sourceUrl = pdfPreviewUrl(result?.downloadUrl);
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
    {!loading && error && <div className="preview-unavailable"><AlertTriangle size={18} /><span>{error} Download the PDF to view it.</span></div>}
    {!loading && !error && pages.length === 0 && <div className="preview-unavailable"><AlertTriangle size={18} /><span>No pages were available for preview. The PDF is ready to download.</span></div>}
    {error && pages.length > 0 && <div className="pdf-preview-error"><AlertTriangle size={16} /><span>Preview rendering stopped after {pages.length} of {totalPages} pages. The complete PDF is ready to download.</span></div>}
  </div>;
}

function PdfJobCard({ job: initialJob, mode = "server", keepResult = false, onReset, onContinue }) {
  const [job, setJob] = useState(initialJob);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  useEffect(() => {
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
  return <section className={`job-card pdf-job-card ${done ? "success" : failed ? "failed" : ""}`}><div className="job-topline"><span className="job-status-pill">{done ? <CheckCircle2 size={15} /> : failed ? <AlertTriangle size={15} /> : <LoaderCircle className="spin" size={15} />}{done ? "Complete" : failed ? "Needs attention" : job.status === "queued" ? "Queued" : "Processing"}</span><span className="job-id">Job {job.id.slice(0, 8)}</span></div><div className="job-icon">{done ? <CheckCircle2 size={30} /> : failed ? <AlertTriangle size={30} /> : <LoaderCircle className="spin" size={30} />}</div><h2>{done ? "Your edited PDF is ready" : failed ? "The PDF could not be created" : job.stage}</h2><p className="job-message">{failed ? job.error : job.message}</p>{!done && !failed && <><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="progress-meta"><span>{job.stage}</span><strong>{progress}%</strong></div></>}<div className="pdf-job-log"><div className="job-log-heading"><span>Worker log</span><span>{(job.logs || []).length} events</span></div><div className="job-log-list">{job.logs?.length ? job.logs.slice(-80).map((entry, index) => <div className={`job-log-entry ${entry.level === "error" ? "error" : ""}`} key={`${entry.time}-${index}`}><time>{new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span>{entry.message}</span></div>) : <div className="job-log-empty">Waiting for progress…</div>}</div></div>{done && job.result && <><div className="pdf-result-preview"><div className="preview-heading"><span>Edited PDF preview</span><small>All {job.result.pageCount || ""} pages</small></div><PdfResultPreview result={job.result} /></div><div className="result-summary"><div><span>Output</span><strong>{job.result.filename}</strong></div><div><span>Size</span><strong>{formatBytes(job.result.bytes)}</strong></div><div><span>Pages</span><strong>{job.result.pageCount}</strong></div><div><span>Method</span><strong>{job.result.method}</strong></div></div></>} {done && job.result && <ResultDownloadNote result={job.result} mode={mode} keepResult={keepResult} />} {printError && <div className="error-banner"><AlertTriangle size={17} /><span>{printError}</span></div>}<div className="job-actions">{done && job.result && <><a className="primary-button" href={job.result.downloadUrl} download={job.result.filename}><Download size={18} /> Download PDF</a><button className="secondary-button" type="button" onClick={printPdf} disabled={printing}><Printer size={17} /> {printing ? "Preparing print…" : "Print PDF"}</button><button className="secondary-button" type="button" onClick={() => onContinue?.(job.result)}><FilePlus2 size={17} /> Continue editing</button></>}<button className="secondary-button" type="button" onClick={onReset}><RotateCcw size={17} /> {done || failed ? "Edit another PDF" : "Cancel"}</button></div></section>;
}
