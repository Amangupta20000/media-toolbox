"use client";

import { Fragment, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileText, Keyboard, LoaderCircle, Pencil, Printer, RotateCcw, Save, ShieldCheck, UploadCloud, X, ZoomIn, ZoomOut } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { FileDropzone, formatBytes } from "./file-dropzone.jsx";
import { ProcessingMode } from "./processing-mode.jsx";
import { ResultDownloadNote } from "./result-download-note.jsx";
import { downloadFilename, downloadUrlWithFilename, filenameStem, ResultFilenameField } from "./result-filename.jsx";
import { ToolHistory, ToolViewTabs } from "./tool-history.jsx";
import { deleteProcessingJob, getProcessingJob, inspectPdfWithOcr, isProcessingLocationReady, processingCapabilities, probeProcessingLocations, uploadWithProgress } from "./processing-client.js";
import { applyRasterTextEdits } from "../lib/pdf-ocr-raster.js";
import { MAX_PDF_BYTES } from "../lib/pdf-limits.js";
import { mergeAdjacentTextRuns } from "../lib/pdf-text-runs.js";
import { graphemeCount } from "../lib/text-metrics.js";
import { takeHistoryEdit } from "./history-edit.js";

async function loadPdfLibrary() {
  const library = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (library.GlobalWorkerOptions) library.GlobalWorkerOptions.workerSrc = "/api/pdf/worker";
  return library;
}

async function hashBytes(value) {
  const digest = await window.crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function textHash(value) {
  return window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
}

function runId(pageIndex, ordinal, text, sourceHash) {
  return textHash(text).then((textDigest) => `p${pageIndex}-o${ordinal}-t${textDigest.slice(0, 16)}-f${sourceHash.slice(0, 16)}`);
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, "");
}

function textOffset(value) {
  const x = Number(value?.x) || 0;
  const y = Number(value?.y) || 0;
  return { x, y };
}

function hasTextOffset(value) {
  const offset = textOffset(value);
  return Math.abs(offset.x) > 0.01 || Math.abs(offset.y) > 0.01;
}

function visualRunKey(run) {
  const geometry = run.bbox
    ? [run.bbox.x0, run.bbox.y0, run.bbox.x1, run.bbox.y1]
    : [...(run.item?.transform || []), run.item?.width, run.item?.height];
  return [run.mode || "native", normalizeText(run.text), ...geometry.map((value) => Number.isFinite(Number(value)) ? Number(value).toFixed(3) : "")].join("|");
}

function operatorGroupForRun(run) {
  return {
    operatorOrdinal: run.ordinal,
    operatorOrdinals: Array.isArray(run.operatorOrdinals) && run.operatorOrdinals.length ? run.operatorOrdinals : [run.ordinal],
    runId: run.runId,
    originalTextHash: run.originalTextHash,
    originalText: run.text,
  };
}

function mergeVisualDuplicateRuns(runs) {
  const merged = [];
  const byVisualKey = new Map();
  for (const run of runs) {
    const key = visualRunKey(run);
    const existing = byVisualKey.get(key);
    if (!existing) {
      const logicalRun = { ...run, duplicateCount: 1, operatorGroups: [operatorGroupForRun(run)] };
      byVisualKey.set(key, logicalRun);
      merged.push(logicalRun);
      continue;
    }
    existing.duplicateCount += 1;
    existing.operatorGroups.push(operatorGroupForRun(run));
    existing.editable = existing.editable && run.editable;
    if (!existing.editable && run.reason) existing.reason = run.reason;
  }
  return merged;
}

function serializedOperatorGroups(run) {
  if (!Array.isArray(run.operatorGroups) || run.operatorGroups.length < 2) return undefined;
  return run.operatorGroups.map((group) => ({
    operatorOrdinal: group.operatorOrdinal,
    operatorOrdinals: group.operatorOrdinals,
  }));
}

function operatorText(args) {
  const characters = Array.isArray(args?.[0]) ? args[0] : [];
  return characters.map((character) => typeof character === "string" ? character : character?.unicode || "").join("");
}

function grayToHex(value) {
  const channel = Math.max(0, Math.min(255, Math.round(Number(value || 0) * 255))).toString(16).padStart(2, "0");
  return `#${channel}${channel}${channel}`;
}

function fillColorFromOperator(fn, args, pdfLibrary, current) {
  if (fn === pdfLibrary.OPS.setFillRGBColor && typeof args?.[0] === "string") return args[0];
  if (fn === pdfLibrary.OPS.setFillGray) return grayToHex(args?.[0]);
  return current;
}

function likelyFullPageImageIndexes(operatorList, pdfPage, pdfLibrary) {
  const view = pdfPage.view || [];
  const pageWidth = Math.abs(Number(view[2]) - Number(view[0]));
  const pageHeight = Math.abs(Number(view[3]) - Number(view[1]));
  const pageRatio = Math.min(pageWidth, pageHeight) / Math.max(pageWidth, pageHeight);
  if (!Number.isFinite(pageRatio) || pageRatio <= 0) return [];
  const imageFunctions = new Set([
    pdfLibrary.OPS.paintImageXObject,
    pdfLibrary.OPS.paintImageMaskXObject,
    pdfLibrary.OPS.paintSolidColorImageMask,
  ].filter((value) => value !== undefined));
  return operatorList.fnArray.flatMap((fn, index) => {
    if (!imageFunctions.has(fn)) return [];
    const args = operatorList.argsArray[index];
    const width = Number(args?.[1]);
    const height = Number(args?.[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 300 || height < 300) return [];
    const imageRatio = Math.min(width, height) / Math.max(width, height);
    return Math.abs(imageRatio - pageRatio) <= 0.04 ? [index] : [];
  });
}

async function inspectPage(pdfPage, pageIndex, pdfLibrary, sourceHash) {
  const [textContent, operatorList] = await Promise.all([pdfPage.getTextContent({ disableCombineTextItems: true }), pdfPage.getOperatorList()]);
  const fullPageImageIndexes = likelyFullPageImageIndexes(operatorList, pdfPage, pdfLibrary);
  const operators = [];
  let fillColor = "#000000";
  let ordinal = 0;
  const textOperatorFunctions = new Set([
    pdfLibrary.OPS.showText,
    pdfLibrary.OPS.showSpacedText,
    pdfLibrary.OPS.nextLineShowText,
    pdfLibrary.OPS.nextLineSetSpacingShowText,
  ].filter((value) => value !== undefined));
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    fillColor = fillColorFromOperator(operatorList.fnArray[index], operatorList.argsArray[index], pdfLibrary, fillColor);
    if (!textOperatorFunctions.has(operatorList.fnArray[index])) continue;
    const text = operatorText(operatorList.argsArray[index]);
    operators.push({ ordinal, text, operatorIndex: index, color: fillColor });
    ordinal += 1;
  }
  const operatorByOrdinal = new Map(operators.map((operator) => [operator.ordinal, operator]));
  const normalizedStream = [];
  const streamOrdinals = [];
  for (const operator of operators) {
    for (const character of normalizeText(operator.text)) {
      normalizedStream.push(character);
      streamOrdinals.push(operator.ordinal);
    }
  }
  const streamText = normalizedStream.join("");
  let streamCursor = 0;
  const runs = [];
  for (let itemIndex = 0; itemIndex < textContent.items.length; itemIndex += 1) {
    const item = textContent.items[itemIndex];
    const text = String(item?.str || "");
    const normalizedText = normalizeText(text);
    if (!normalizedText) continue;
    const start = streamText.indexOf(normalizedText, streamCursor);
    if (start < 0) continue;
    const end = start + normalizedText.length;
    const matchedOrdinals = streamOrdinals.slice(start, end);
    const firstMatchedOrdinal = matchedOrdinals[0];
    const lastMatchedOrdinal = matchedOrdinals[matchedOrdinals.length - 1];
    const operatorOrdinals = operators.slice(firstMatchedOrdinal, lastMatchedOrdinal + 1).map((candidate) => candidate.ordinal);
    const operator = operatorByOrdinal.get(operatorOrdinals.find((value) => normalizeText(operatorByOrdinal.get(value)?.text) !== "") ?? firstMatchedOrdinal);
    if (!operator || !operatorOrdinals.length) continue;
    const groupedText = operatorOrdinals.map((value) => operatorByOrdinal.get(value)?.text || "").join("");
    if (normalizeText(groupedText) !== normalizedText) continue;
    streamCursor = end;
    const sourceText = operator.text || text;
    runs.push({
      ...operator,
      pageIndex,
      text,
      originalText: text,
      operatorText: sourceText,
      operatorOrdinals,
      operatorEndIndex: operatorByOrdinal.get(lastMatchedOrdinal)?.operatorIndex ?? operator.operatorIndex,
      originalTextHash: await textHash(sourceText),
      runId: await runId(pageIndex, operator.ordinal, sourceText, sourceHash),
      item,
      itemIndex,
      color: operator.color,
      editable: Boolean(text && !text.includes("\ufffd")),
      reason: text ? "This text run could not be mapped safely to the PDF text layer." : "This page does not expose selectable text.",
    });
  }
  const logicalRuns = mergeAdjacentTextRuns(runs, textContent.items);
  const visibleRuns = logicalRuns.filter((run) => !fullPageImageIndexes.some((imageIndex) => imageIndex > run.operatorEndIndex));
  const hasTextItems = textContent.items.some((item) => normalizeText(item?.str));
  return {
    pageIndex,
    page: pdfPage,
    runs: mergeVisualDuplicateRuns(visibleRuns),
    textItemCount: textContent.items.length,
    requiresOcr: hasTextItems && visibleRuns.length === 0,
    pageLabel: `Page ${pageIndex + 1}`,
  };
}

function PdfTextThumbnail({ model, onSelect }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    let renderTask;
    const viewport = model.page.getViewport({ scale: Math.min(0.22, 100 / model.page.getViewport({ scale: 1 }).width) });
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    renderTask = model.page.render({ canvasContext: canvas.getContext("2d"), viewport });
    renderTask.promise.catch(() => undefined);
    return () => renderTask?.cancel();
  }, [model]);
  return <button className="pdf-text-thumbnail" type="button" onClick={onSelect} aria-label={`Select ${model.pageLabel}`}><canvas ref={canvasRef} /><span>{model.pageLabel}</span></button>;
}

const MAX_VIRTUAL_ITEMS = 50;
const VIRTUAL_OVERSCAN = 3;

function useResponsiveVirtualAxis() {
  const [horizontal, setHorizontal] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setHorizontal(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  return horizontal;
}

function useVirtualWindow(containerRef, count, itemSize, axis = "vertical") {
  const horizontal = axis === "horizontal";
  const [metrics, setMetrics] = useState({ offset: 0, viewport: 760 });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    let frame = 0;
    const update = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const viewport = horizontal ? container.clientWidth : container.clientHeight;
        const offset = horizontal ? container.scrollLeft : container.scrollTop;
        setMetrics({ offset, viewport: Math.max(1, viewport) });
      });
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(container);
    return () => {
      container.removeEventListener("scroll", update);
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [containerRef, count, horizontal, itemSize]);

  const visibleCount = Math.max(1, Math.ceil(metrics.viewport / Math.max(1, itemSize)));
  const start = Math.max(0, Math.floor(metrics.offset / Math.max(1, itemSize)) - VIRTUAL_OVERSCAN);
  const end = Math.min(count, start + Math.min(MAX_VIRTUAL_ITEMS, visibleCount + VIRTUAL_OVERSCAN * 2));
  return { horizontal, start, end, totalSize: count * itemSize };
}

function useEstimatedPreviewPageHeight() {
  const [height, setHeight] = useState(890);
  useEffect(() => {
    const update = () => {
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      const frameHeight = Math.min(window.innerHeight * (mobile ? 0.68 : 0.7), mobile ? 520 : 760);
      setHeight(Math.max(mobile ? 620 : 520, Math.ceil(frameHeight + (mobile ? 125 : 130))));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return height;
}

function PdfTextPage({ model, selectedRunId, edits, textOffsets, pdfLibrary, previewZoom, onSelectRun, onMoveRun, onMoveRunEnd, pageRef }) {
  const frameRef = useRef(null);
  const surfaceRef = useRef(null);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const rerenderRef = useRef(false);
  const [viewport, setViewport] = useState(null);
  const [surfaceSize, setSurfaceSize] = useState(null);
  const rasterPreviewOffsets = model.ocr ? textOffsets : null;
  useEffect(() => {
    let active = true;
    const render = async () => {
      if (renderTaskRef.current) {
        rerenderRef.current = true;
        return;
      }
      const frame = frameRef.current;
      const surface = surfaceRef.current;
      const canvas = canvasRef.current;
      if (!frame || !surface || !canvas) return;
      const base = model.page.getViewport({ scale: 1 });
      const availableWidth = Math.max(1, frame.clientWidth - 36);
      const availableHeight = Math.max(1, frame.clientHeight - 36);
      const fitScale = Math.min(availableWidth / base.width, availableHeight / base.height);
      // Keep zoom attached to the page surface so the frame can scroll when
      // the user magnifies beyond the available preview area.
      const scale = Math.min(1.35, Math.max(0.45, fitScale)) * previewZoom;
      // Keep the layout viewport in CSS pixels, but render the canvas at the
      // device pixel ratio so uploaded PDFs stay crisp on Retina/high-density
      // displays. The canvas is then downsampled by CSS without changing the
      // page dimensions or overlay coordinates.
      const pixelRatio = Math.min(3, Math.max(1, Number(window.devicePixelRatio) || 1));
      const nextViewport = model.page.getViewport({ scale });
      const renderViewport = model.page.getViewport({ scale: scale * pixelRatio });
      setSurfaceSize({ width: nextViewport.width, height: nextViewport.height });
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      const renderTask = model.page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: renderViewport });
      renderTaskRef.current = renderTask;
      try {
        await renderTask.promise;
        if (active && model.ocr) {
          const pageEdits = model.runs
            .filter((run) => edits[run.runId] !== undefined || hasTextOffset(textOffsets[run.runId]))
            .map((run) => ({
              originalText: run.originalText,
              replacementText: edits[run.runId] !== undefined ? edits[run.runId] : run.text,
              bbox: {
                x0: run.bbox.x0 * canvas.width / Math.max(1, Number(model.imageWidth) || canvas.width),
                y0: run.bbox.y0 * canvas.height / Math.max(1, Number(model.imageHeight) || canvas.height),
                x1: run.bbox.x1 * canvas.width / Math.max(1, Number(model.imageWidth) || canvas.width),
                y1: run.bbox.y1 * canvas.height / Math.max(1, Number(model.imageHeight) || canvas.height),
              },
              offsetX: textOffset(textOffsets[run.runId]).x * canvas.width / Math.max(1, base.width),
              offsetY: textOffset(textOffsets[run.runId]).y * canvas.height / Math.max(1, base.height),
              confidence: run.confidence,
            }));
          applyRasterTextEdits(canvas, pageEdits);
        }
        if (active) setViewport(nextViewport);
      } catch (error) {
        if (error?.name !== "RenderingCancelledException") throw error;
      } finally {
        if (renderTaskRef.current === renderTask) renderTaskRef.current = null;
        if (active && rerenderRef.current) {
          rerenderRef.current = false;
          window.requestAnimationFrame(() => render().catch(() => undefined));
        }
      }
    };
    render().catch(() => undefined);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => render().catch(() => undefined)) : null;
    if (frameRef.current) observer?.observe(frameRef.current);
    return () => { active = false; rerenderRef.current = false; renderTaskRef.current?.cancel(); renderTaskRef.current = null; observer?.disconnect(); };
  }, [edits, model, pdfLibrary, previewZoom, rasterPreviewOffsets]);

  const baseViewport = model.page.getViewport({ scale: 1 });
  const positions = useMemo(() => {
    if (!viewport) return [];
    const pageScaleX = viewport.width / Math.max(1, baseViewport.width);
    const pageScaleY = viewport.height / Math.max(1, baseViewport.height);
    return model.runs.map((run) => {
      const offset = textOffset(textOffsets[run.runId]);
      if (run.bbox && model.imageWidth && model.imageHeight) {
        const scaleX = viewport.width / model.imageWidth;
        const scaleY = viewport.height / model.imageHeight;
        return { ...run, left: run.bbox.x0 * scaleX + offset.x * pageScaleX, top: run.bbox.y0 * scaleY + offset.y * pageScaleY, width: Math.max(5, (run.bbox.x1 - run.bbox.x0) * scaleX), height: Math.max(7, (run.bbox.y1 - run.bbox.y0) * scaleY) };
      }
      if (!run.item?.transform) return { ...run, left: offset.x * pageScaleX, top: offset.y * pageScaleY, width: 0, height: 0 };
      const transform = pdfLibrary.Util.transform(viewport.transform, run.item.transform);
      const height = Math.max(7, Math.hypot(transform[2], transform[3]) || Number(run.item.height) || 12);
      let font = null;
      try {
        if (run.item.fontName && model.page.commonObjs.has(run.item.fontName)) font = model.page.commonObjs.get(run.item.fontName);
      } catch {
        font = null;
      }
      return {
        ...run,
        left: transform[4] + offset.x * pageScaleX,
        top: transform[5] - height + offset.y * pageScaleY,
        width: Math.max(5, Number(run.item.width || 0) * viewport.scale),
        height,
        previewFontFamily: font?.name || "sans-serif",
        previewFontWeight: font?.bold || font?.black ? 700 : 400,
        previewFontStyle: font?.italic ? "italic" : "normal",
      };
    });
  }, [model, pdfLibrary, textOffsets, viewport]);

  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const startTextDrag = (event, run) => {
    if (!run.editable || event.button !== 0 || event.pointerType !== "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    onSelectRun(run);
    const offset = textOffset(textOffsets[run.runId]);
    dragRef.current = { runId: run.runId, startX: event.clientX, startY: event.clientY, startOffset: offset, moved: false, pointerId: event.pointerId };
    suppressClickRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveTextDrag = (event, run) => {
    const drag = dragRef.current;
    if (!drag || drag.runId !== run.runId || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (distance < 2) return;
    drag.moved = true;
    suppressClickRef.current = true;
    const pageScale = viewport ? viewport.width / Math.max(1, baseViewport.width) : 1;
    onMoveRun?.(run.runId, { x: drag.startOffset.x + (event.clientX - drag.startX) / pageScale, y: drag.startOffset.y + (event.clientY - drag.startY) / pageScale });
  };
  const endTextDrag = (event, run) => {
    const drag = dragRef.current;
    if (!drag || drag.runId !== run.runId || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag.moved) {
      const pageScale = viewport ? viewport.width / Math.max(1, baseViewport.width) : 1;
      onMoveRunEnd?.(run.runId, { x: drag.startOffset.x + (event.clientX - drag.startX) / pageScale, y: drag.startOffset.y + (event.clientY - drag.startY) / pageScale });
    }
  };
  const renderRun = (run) => (
    <Fragment key={run.runId}>
      <button
        type="button"
        className={`pdf-text-run ${run.mode === "ocr" ? "ocr" : ""} ${selectedRunId === run.runId ? "selected" : ""} ${edits[run.runId] !== undefined || hasTextOffset(textOffsets[run.runId]) ? "edited" : ""} ${!run.editable ? "not-editable" : ""}`}
        style={{ left: run.left, top: run.top, width: run.width || undefined, height: run.height || undefined }}
        onClick={() => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } onSelectRun(run); }}
        onPointerDown={(event) => startTextDrag(event, run)}
        onPointerMove={(event) => moveTextDrag(event, run)}
        onPointerUp={(event) => endTextDrag(event, run)}
        onPointerCancel={(event) => endTextDrag(event, run)}
        title={run.editable ? `Edit “${run.text}”` : run.reason}
        aria-label={run.editable ? `Edit text ${run.text}` : `Text not editable: ${run.reason}`}
      />
    </Fragment>
  );
  return <article ref={pageRef} className="pdf-text-page" aria-label={model.pageLabel}>
    <div className="pdf-text-page-heading"><strong>{model.pageLabel}</strong><span>{model.runs.length ? `${model.runs.length} ${model.ocr ? "OCR text regions" : "detected text runs"}` : "No editable text detected"}</span></div>
    <div ref={frameRef} className="pdf-text-page-frame">
      <div ref={surfaceRef} className="pdf-text-page-surface" style={{ "--page-ratio": baseViewport.width / baseViewport.height, ...(surfaceSize ? { width: `${surfaceSize.width}px`, height: `${surfaceSize.height}px` } : {}) }}>
        <canvas ref={canvasRef} aria-label={`Preview of ${model.pageLabel}`} />
        {positions.map(renderRun)}
      </div>
    </div>
    {!model.runs.length && <div className="pdf-text-page-empty"><AlertTriangle size={17} /><span>{model.ocr ? "OCR could not find readable text on this page." : "This page may be scanned, outlined, annotation-only, or use an unsupported text encoding."}</span></div>}
  </article>;
}

const VirtualizedPdfTextPreview = forwardRef(function VirtualizedPdfTextPreview({ pages, selectedRunId, edits, textOffsets, pdfLibrary, previewZoom, previewRevision, onSelectRun, onMoveRun, onMoveRunEnd, onPinchZoom }, ref) {
  const scrollRef = useRef(null);
  const previewZoomRef = useRef(previewZoom);
  const pageHeight = useEstimatedPreviewPageHeight();
  const gap = 17;
  const stride = pageHeight + gap;
  const windowed = useVirtualWindow(scrollRef, pages.length, stride);

  useEffect(() => { previewZoomRef.current = previewZoom; }, [previewZoom]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    let gestureZoom = previewZoomRef.current;
    const applyZoom = (value) => {
      const next = Math.max(0.6, Math.min(3, value));
      previewZoomRef.current = next;
      onPinchZoom?.(next);
    };
    const handleWheel = (event) => {
      // Chromium/WebKit report a trackpad two-finger pinch as a ctrl-wheel
      // event. Prevent the browser from zooming the entire application and
      // route the gesture to the page preview zoom instead.
      if (!event.ctrlKey) return;
      event.preventDefault();
      const factor = Math.exp(-Number(event.deltaY || 0) * 0.01);
      if (Number.isFinite(factor) && factor > 0) applyZoom(previewZoomRef.current * factor);
    };
    const handleGestureStart = (event) => {
      event.preventDefault();
      gestureZoom = previewZoomRef.current;
    };
    const handleGestureChange = (event) => {
      event.preventDefault();
      const scale = Number(event.scale);
      if (Number.isFinite(scale) && scale > 0) applyZoom(gestureZoom * scale);
    };
    const handleGestureEnd = (event) => event.preventDefault();
    element.addEventListener("wheel", handleWheel, { passive: false });
    element.addEventListener("gesturestart", handleGestureStart, { passive: false });
    element.addEventListener("gesturechange", handleGestureChange, { passive: false });
    element.addEventListener("gestureend", handleGestureEnd, { passive: false });
    return () => {
      element.removeEventListener("wheel", handleWheel);
      element.removeEventListener("gesturestart", handleGestureStart);
      element.removeEventListener("gesturechange", handleGestureChange);
      element.removeEventListener("gestureend", handleGestureEnd);
    };
  }, [onPinchZoom]);

  useImperativeHandle(ref, () => ({
    scrollToIndex(index) {
      const target = Math.max(0, Math.min(pages.length - 1, Number(index) || 0));
      scrollRef.current?.scrollTo({ top: target * stride, behavior: "smooth" });
    },
  }), [pages.length, stride]);

  return <div ref={scrollRef} className="pdf-text-preview-scroll" aria-label="PDF page previews">
    <div className="pdf-text-virtual-content" style={{ height: `${Math.max(0, pages.length * stride - gap)}px` }}>
      {pages.slice(windowed.start, windowed.end).map((model, offset) => {
        const index = windowed.start + offset;
        return <div key={`${model.pageIndex}-${previewRevision}`} className="pdf-text-virtual-item" style={{ top: `${index * stride}px`, height: `${pageHeight}px` }}>
          <PdfTextPage model={model} selectedRunId={selectedRunId} edits={edits} textOffsets={textOffsets} pdfLibrary={pdfLibrary} previewZoom={previewZoom} onSelectRun={onSelectRun} onMoveRun={onMoveRun} onMoveRunEnd={onMoveRunEnd} />
        </div>;
      })}
    </div>
  </div>;
});

function VirtualizedPdfTextRail({ pages, onSelect }) {
  const scrollRef = useRef(null);
  const horizontal = useResponsiveVirtualAxis();
  const itemSize = horizontal ? 145 : 235;
  const windowed = useVirtualWindow(scrollRef, pages.length, itemSize, horizontal ? "horizontal" : "vertical");
  const contentStyle = horizontal
    ? { width: `${windowed.totalSize}px`, height: "100%" }
    : { width: "100%", height: `${windowed.totalSize}px` };
  return <aside className="pdf-text-page-rail">
    <div className="pdf-text-rail-heading"><strong>Pages</strong><span>{pages.length || 0}</span></div>
    {pages.length ? <div ref={scrollRef} className="pdf-text-page-rail-scroll">
      <div className="pdf-text-rail-virtual-content" style={contentStyle}>
        {pages.slice(windowed.start, windowed.end).map((model, offset) => {
          const index = windowed.start + offset;
          const itemStyle = horizontal
            ? { left: `${index * itemSize}px`, top: 0, width: `${itemSize}px`, height: "100%" }
            : { left: 0, top: `${index * itemSize}px`, width: "100%", height: `${itemSize}px` };
          return <div key={model.pageIndex} className="pdf-text-rail-virtual-item" style={itemStyle}><PdfTextThumbnail model={model} onSelect={() => onSelect(index)} /></div>;
        })}
      </div>
    </div> : <div className="pdf-text-rail-empty">Thumbnails appear here.</div>}
  </aside>;
}

function TextEditPopover({ run, value, onChange, onSave, onCancel, onRestore }) {
  if (!run) return null;
  const overflow = graphemeCount(value) > graphemeCount(run.text);
  return <div className="pdf-text-edit-popover" role="dialog" aria-label={`Edit ${run.text} on page ${run.pageIndex + 1}`}><div className="pdf-text-edit-heading"><div><span>Selected text · Page {run.pageIndex + 1}</span><strong title={run.text}>{run.text}</strong></div><button className="icon-button" type="button" onClick={onCancel} aria-label="Close text editor" title="Close"><X size={17} /></button></div><input autoFocus value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSave(); if (event.key === "Escape") onCancel(); }} aria-label="Replacement text" /><div className="pdf-text-edit-actions"><button className="primary-button" type="button" onClick={onSave}><Save size={15} /> Save text</button><button className="secondary-button" type="button" onClick={onRestore}><RotateCcw size={15} /> Restore original</button><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button></div>{overflow && <div className="pdf-text-overflow-warning"><AlertTriangle size={15} /><span>This replacement is longer. It will overflow if necessary; surrounding content will not reflow.</span></div>}</div>;
}

function formatLogTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function PdfTextJobLog({ logs }) {
  return <div className="job-log-panel"><div className="job-log-heading"><span><span className="log-live-dot" /> Worker log</span><span>{logs.length} events</span></div><div className="job-log-list" aria-live="polite">{logs.length ? logs.slice(-80).map((entry, index) => <div className={`job-log-entry ${entry.level === "error" ? "error" : ""}`} key={`${entry.time}-${index}`}><time>{formatLogTime(entry.time)}</time><span>{entry.message}</span></div>) : <div className="job-log-empty">Waiting for the worker to report progress…</div>}</div></div>;
}

function PdfTextJobCard({ initialJob, mode, onReset, onContinue, keepResult }) {
  const [job, setJob] = useState(initialJob);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  const [filenameStemValue, setFilenameStemValue] = useState("");
  useEffect(() => {
    let active = true;
    let timer;
    const schedulePoll = () => { timer = window.setTimeout(poll, 1000); };
    const poll = async () => {
      if (!active) return;
      try {
        const current = await getProcessingJob(mode, initialJob.id);
        if (!active) return;
        setJob(current);
        if (["queued", "processing"].includes(current.status)) schedulePoll();
      } catch (error) {
        if (!active) return;
        if (error?.code === "request_timeout") {
          setJob((value) => ({ ...value, status: "processing", stage: value.stage || "Processing", message: "The PDF is still being edited. Waiting for the worker…", error: null }));
          schedulePoll();
          return;
        }
        setJob((value) => ({ ...value, status: "failed", error: error instanceof Error ? error.message : "Unable to read PDF text job status." }));
      }
    };
    poll();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [initialJob.id, mode]);
  const done = job.status === "completed";
  const failed = job.status === "failed";
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const downloadName = done && job.result ? downloadFilename(filenameStemValue || filenameStem(job.result.filename), job.result.filename) : "";
  const printPdf = async () => {
    if (!job.result?.downloadUrl || printing) return;
    setPrinting(true); setPrintError("");
    let printWindow;
    let objectUrl = "";
    try {
      printWindow = window.open("about:blank", "_blank");
      if (!printWindow) throw new Error("Printing was blocked by the browser. Allow pop-ups for this site and try again.");
      const response = await fetch(job.result.downloadUrl, { cache: "no-store" });
      if (!response.ok) throw new Error("The PDF could not be opened for printing.");
      objectUrl = URL.createObjectURL(await response.blob());
      printWindow.location.href = objectUrl;
      window.setTimeout(() => { if (printWindow && !printWindow.closed) { printWindow.focus(); printWindow.print(); } }, 1200);
    } catch (error) {
      if (printWindow && !printWindow.closed) printWindow.close();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setPrintError(error instanceof Error ? error.message : "The PDF could not be opened for printing.");
    } finally { setPrinting(false); }
  };
  return <section className={`job-card pdf-job-card ${done ? "success" : failed ? "failed" : ""}`}><div className="job-topline"><span className="job-status-pill">{done ? <CheckCircle2 size={15} /> : failed ? <AlertTriangle size={15} /> : <LoaderCircle className="spin" size={15} />}{done ? "Complete" : failed ? "Needs attention" : "Processing"}</span><span className="job-id">Job {job.id.slice(0, 8)}</span></div><div className="job-icon">{done ? <CheckCircle2 size={30} /> : failed ? <AlertTriangle size={30} /> : <LoaderCircle className="spin" size={30} />}</div><h2>{done ? "Your edited PDF is ready" : failed ? "The PDF could not be edited" : job.stage}</h2><p className="job-message">{failed ? job.error : job.message}</p>{!done && !failed && <><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="progress-meta"><span>{job.stage}</span><strong>{progress}%</strong></div></>}<PdfTextJobLog logs={job.logs || []} />{job.warnings?.length > 0 && <div className="pdf-text-export-warnings"><AlertTriangle size={16} /><div>{job.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div></div>}{done && job.result && <><div className="pdf-text-result-preview"><div className="preview-heading"><span>Edited PDF preview</span><small>{job.result.pageCount} pages</small></div><iframe src={`${job.result.downloadUrl}${job.result.downloadUrl.includes("?") ? "&" : "?"}preview=1`} title={`Preview of ${job.result.filename}`} /></div><div className="result-summary"><div><span>Output</span><strong title={job.result.filename}>{job.result.filename}</strong></div><div><span>Size</span><strong>{formatBytes(job.result.bytes)}</strong></div><div><span>Edits</span><strong>{job.result.editCount}</strong></div><div><span>Method</span><strong>{job.result.method}</strong></div></div><ResultDownloadNote result={job.result} mode={mode} keepResult={keepResult} filename={downloadName} /><ResultFilenameField originalFilename={job.result.filename} value={filenameStemValue || filenameStem(job.result.filename)} onChange={setFilenameStemValue} /></>}{printError && <div className="error-banner"><AlertTriangle size={17} /><span>{printError}</span></div>}<div className="job-actions">{done && job.result && <><a className="primary-button" href={downloadUrlWithFilename(job.result.downloadUrl, downloadName)} download={downloadName}><Download size={17} /> Download PDF</a><button className="secondary-button" type="button" onClick={printPdf} disabled={printing}><Printer size={17} /> {printing ? "Preparing print…" : "Print PDF"}</button></>}{(done || failed) && <button className="secondary-button" type="button" onClick={onContinue}><Pencil size={17} /> Continue editing</button>}<button className="secondary-button" type="button" onClick={onReset}><RotateCcw size={17} /> {done || failed ? "Edit another PDF" : "Cancel"}</button></div></section>;
}

export function PdfTextEditor() {
  const [pdfLibrary, setPdfLibrary] = useState(null);
  const [source, setSource] = useState(null);
  const [sourceHash, setSourceHash] = useState("");
  const [pages, setPages] = useState([]);
  const [edits, setEdits] = useState({});
  const [textOffsets, setTextOffsets] = useState({});
  const [selectedRun, setSelectedRun] = useState(null);
  const [editorValue, setEditorValue] = useState("");
  const [processingMode, setProcessingMode] = useState("server");
  const [jobMode, setJobMode] = useState("server");
  const [locations, setLocations] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [keepResult, setKeepResult] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState("Reading PDF text and building previews…");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeView, setActiveView] = useState("tool");
  const [previewUpdating, setPreviewUpdating] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const previewVirtualizerRef = useRef(null);
  const previewRequestRef = useRef(0);
  const historyEditLoadedRef = useRef(false);
  const sourceBytesRef = useRef(null);
  const sourcePasswordRef = useRef("");

  useEffect(() => { loadPdfLibrary().then(setPdfLibrary).catch(() => setError("PDF preview support could not be loaded. Refresh and try again.")); }, []);
  useEffect(() => { probeProcessingLocations().then((value) => { setLocations(value); const preferred = value.server.connected ? "server" : value.local.connected || value.local.ready ? "local" : "server"; setProcessingMode(preferred); setCapabilities(processingCapabilities(value, preferred)); }).catch(() => undefined); }, []);
  useEffect(() => setCapabilities(processingCapabilities(locations, processingMode)), [locations, processingMode]);
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (activeView !== "tool" || job || loading) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, button, [contenteditable=\"true\"]")) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setPreviewZoom((current) => Math.min(3, Math.round((current + 0.1) * 10) / 10));
      } else if (event.key === "-") {
        event.preventDefault();
        setPreviewZoom((current) => Math.max(0.6, Math.round((current - 0.1) * 10) / 10));
      } else if (event.key === "0") {
        event.preventDefault();
        setPreviewZoom(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeView, job, loading]);

  const selectFile = async (file) => {
    setError("");
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) { setError("Choose a PDF file."); return; }
    if (file.size > MAX_PDF_BYTES) { setError("The PDF must be 200 MB or smaller."); return; }
    if (!pdfLibrary) { setError("PDF preview support is still loading. Try again in a moment."); return; }
    previewRequestRef.current += 1;
    setLoading(true); setSource(file); setPages([]); setEdits({}); setTextOffsets({}); setSelectedRun(null); setOcrProgress(0); setLoadingMessage("Reading PDF text and building previews…"); sourcePasswordRef.current = "";
    let pdfPassword = "";
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      // PDF.js may transfer the buffer to its worker and detach it from the
      // caller. Keep an independent copy for rebuilding the live edited PDF.
      sourceBytesRef.current = data.slice();
      const digest = await hashBytes(data);
      const task = pdfLibrary.getDocument({ data });
      task.onPassword = (callback, reason) => {
        const password = window.prompt(reason === 2 ? "That PDF password was incorrect. Enter it again." : "Enter the password to open this PDF.");
        if (password === null) callback(null); else { pdfPassword = password; sourcePasswordRef.current = password; callback(password); }
      };
      const loaded = await task.promise;
      const models = [];
      for (let pageIndex = 0; pageIndex < loaded.numPages; pageIndex += 1) models.push(await inspectPage(await loaded.getPage(pageIndex + 1), pageIndex, pdfLibrary, digest));
      setSourceHash(digest);
      const ocrPageIndexes = models.filter((model) => model.requiresOcr).map((model) => model.pageIndex);
      if (ocrPageIndexes.length && !isProcessingLocationReady(locations, processingMode)) {
        setPages(models);
        setError("Some pages contain hidden or unsupported text. Connect the Local agent or Server to run OCR on those pages.");
      } else if (ocrPageIndexes.length && processingMode === "local" && capabilities && capabilities.pdf?.ocr !== true) {
        setPages(models);
        setError("PDF OCR is not available in this Local Agent. Update the agent, restart it, and try the PDF again.");
      } else if (ocrPageIndexes.length) {
        setLoadingMessage(`Some pages need visual text detection. Running OCR on ${ocrPageIndexes.length} page${ocrPageIndexes.length === 1 ? "" : "s"}…`);
        const ocrResult = await inspectPdfWithOcr(file, processingMode, setOcrProgress, pdfPassword, ocrPageIndexes);
        const ocrByPage = new Map((ocrResult.pages || []).map((page) => [page.pageIndex, page]));
        const mergedModels = models.map((model) => {
          const ocrPage = ocrByPage.get(model.pageIndex);
          return ocrPage ? { ...ocrPage, page: model.page, textItemCount: model.textItemCount, ocr: true } : model;
        });
        setPages(mergedModels);
        if (!Number(ocrResult.totalRuns)) setError("OCR could not detect readable text on the affected PDF pages. Scanned pages may have low resolution or unsupported handwriting.");
      } else if (models.some((model) => model.runs.some((run) => run.editable))) {
        setPages(models);
      } else if (!isProcessingLocationReady(locations, processingMode)) {
        setPages(models);
        setError("This PDF has no embedded text. Connect the Local agent or Server to run OCR on scanned pages.");
      } else if (processingMode === "local" && capabilities && capabilities.pdf?.ocr !== true) {
        setPages(models);
        setError("PDF OCR is not available in this Local Agent. Update the agent, restart it, and try the PDF again.");
      } else {
        setLoadingMessage("No embedded text found. Running OCR on the PDF…");
        const ocrResult = await inspectPdfWithOcr(file, processingMode, setOcrProgress, pdfPassword);
        const ocrModels = [];
        for (const page of ocrResult.pages || []) {
          ocrModels.push({ ...page, page: await loaded.getPage(page.pageIndex + 1), textItemCount: 0, ocr: true });
        }
        setPages(ocrModels);
        if (!Number(ocrResult.totalRuns)) setError("OCR could not detect readable text in this PDF. Scanned pages may have low resolution or unsupported handwriting.");
      }
    } catch (loadError) {
      setSource(null); setPages([]);
      setError(loadError?.name === "PasswordException" ? "The PDF password was incorrect or the encrypted PDF cannot be edited safely." : loadError instanceof Error ? loadError.message : "The PDF could not be opened for text editing.");
    } finally { setLoading(false); setOcrProgress(0); }
  };

  useEffect(() => {
    if (!pdfLibrary || historyEditLoadedRef.current) return undefined;
    historyEditLoadedRef.current = true;
    const pending = takeHistoryEdit("pdf-text-editor");
    if (!pending?.downloadUrl) return undefined;
    let active = true;
    fetch(pending.downloadUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("The saved PDF could not be reopened.");
      const blob = await response.blob();
      if (active) await selectFile(new File([blob], pending.filename || "saved.pdf", { type: pending.mime || "application/pdf" }));
    }).catch((loadError) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "The saved PDF could not be reopened.");
    });
    return () => { active = false; };
  }, [pdfLibrary]);

  const editableCount = pages.reduce((total, page) => total + page.runs.filter((run) => run.editable).length, 0);
  const ocrPages = pages.filter((page) => page.ocr);
  const nativePages = pages.length - ocrPages.length;
  const ocrDetected = ocrPages.length > 0;
  const ocrPageScope = ocrPages.length <= 3
    ? `OCR on ${ocrPages.map((page) => `page ${page.pageIndex + 1}`).join(", ")}`
    : `OCR on ${ocrPages.length} pages`;
  const changedEdits = pages.flatMap((page) => page.runs
    .filter((run) => run.editable && (edits[run.runId] !== undefined || hasTextOffset(textOffsets[run.runId])))
    .map((run) => [run.runId, edits[run.runId] !== undefined ? edits[run.runId] : run.text]));
  const canSubmit = Boolean(source && sourceHash && changedEdits.length && !loading && !uploadProgress && isProcessingLocationReady(locations, processingMode));

  const chooseRun = (run) => {
    // Resolve the clicked run from the current page model. PDF.js page
    // proxies are replaced after a live preview rebuild, so keeping the
    // object supplied by an older render can leave the editor input pointing
    // at a different run than the hitbox under the pointer.
    const currentRun = pages
      .find((page) => page.pageIndex === run.pageIndex)
      ?.runs.find((candidate) => candidate.runId === run.runId) || run;
    setSelectedRun(currentRun);
    setEditorValue(edits[currentRun.runId] ?? currentRun.text);
    setError(currentRun.editable ? "" : currentRun.reason);
  };
  const changePreviewZoom = (delta) => setPreviewZoom((current) => Math.min(3, Math.max(0.6, Math.round((current + delta) * 10) / 10)));
  const resetPreviewZoom = () => setPreviewZoom(1);
  const refreshEditedPreview = async (nextEdits, nextOffsets = textOffsets) => {
    if (!sourceBytesRef.current || !pdfLibrary) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    const previewEdits = pages.flatMap((page) => page.runs
      .filter((run) => nextEdits[run.runId] !== undefined || hasTextOffset(nextOffsets[run.runId]))
      .map((run) => { const offset = textOffset(nextOffsets[run.runId]); return { pageIndex: run.pageIndex, operatorOrdinal: run.ordinal, ...(run.operatorOrdinals?.length > 1 ? { operatorOrdinals: run.operatorOrdinals } : {}), ...(serializedOperatorGroups(run) ? { operatorGroups: serializedOperatorGroups(run) } : {}), originalText: run.text || run.originalText, replacementText: nextEdits[run.runId] !== undefined ? nextEdits[run.runId] : run.text || run.originalText, mode: run.mode || "native", offsetX: offset.x, offsetY: offset.y, ...(run.bbox ? { bbox: run.bbox, confidence: run.confidence } : {}) }; }));
    setPreviewUpdating(true);
    try {
      const nativePreviewEdits = previewEdits.filter((edit) => edit.mode !== "ocr");
      if (!nativePreviewEdits.length) {
        // OCR pages are rendered from the original PDF page and edited on the
        // canvas by PdfTextPage. This gives immediate feedback and keeps the
        // preview on the exact same raster path as the worker export.
        setError("");
        return;
      }
      const { createPdfTextPreview } = await import("../lib/pdf-text-preview.js");
      const previewBytes = await createPdfTextPreview(sourceBytesRef.current, nativePreviewEdits);
      const previewPdf = await pdfLibrary.getDocument({ data: previewBytes }).promise;
      // PDF.js returns a Promise from getPage(). Passing that Promise into the
      // page model leaves the old canvas in place and prevents an empty
      // replacement from visibly removing the original text.
      const previewPages = await Promise.all(pages.map((page) => previewPdf.getPage(page.pageIndex + 1)));
      if (requestId !== previewRequestRef.current) return;
      const previewPagesByIndex = new Map(pages.map((page, index) => [page.pageIndex, previewPages[index]]));
      setPages((current) => current.map((page) => {
        const previewPage = previewPagesByIndex.get(page.pageIndex);
        return previewPage ? { ...page, page: previewPage } : page;
      }));
      // Force each page renderer to mount against the new PDFDocumentProxy.
      // This avoids retaining a canvas painted from the original document when
      // the page index and layout are otherwise unchanged.
      setPreviewRevision((current) => current + 1);
      setError("");
    } catch (previewError) {
      if (requestId === previewRequestRef.current) setError(previewError instanceof Error ? previewError.message : "The live PDF preview could not be rebuilt.");
    } finally {
      if (requestId === previewRequestRef.current) setPreviewUpdating(false);
    }
  };
  const moveRun = (runId, offset) => setTextOffsets((current) => ({ ...current, [runId]: textOffset(offset) }));
  const finishMovingRun = (runId, offset) => {
    const nextOffsets = { ...textOffsets, [runId]: textOffset(offset) };
    setTextOffsets(nextOffsets);
    refreshEditedPreview(edits, nextOffsets).catch(() => undefined);
  };
  const saveEdit = () => {
    if (!selectedRun) return;
    const value = editorValue;
    const nextEdits = value === selectedRun.text
      ? Object.fromEntries(Object.entries(edits).filter(([key]) => key !== selectedRun.runId))
      : { ...edits, [selectedRun.runId]: value };
    setEdits(nextEdits);
    setSelectedRun(null);
    refreshEditedPreview(nextEdits, textOffsets).catch(() => undefined);
  };
  const restoreEdit = () => {
    if (!selectedRun) return;
    const nextEdits = Object.fromEntries(Object.entries(edits).filter(([key]) => key !== selectedRun.runId));
    const nextOffsets = Object.fromEntries(Object.entries(textOffsets).filter(([key]) => key !== selectedRun.runId));
    setEdits(nextEdits);
    setTextOffsets(nextOffsets);
    setEditorValue(selectedRun.text);
    refreshEditedPreview(nextEdits, nextOffsets).catch(() => undefined);
  };
  const scrollToPage = (pageIndex) => {
    // Do not leave an editor popover from another page open while the newly
    // scrolled page is receiving pointer events.
    setSelectedRun(null);
    setEditorValue("");
    previewVirtualizerRef.current?.scrollToIndex(pageIndex);
  };
  const reset = () => {
    previewRequestRef.current += 1;
    if (job && ["queued", "processing"].includes(job.status)) deleteProcessingJob(jobMode, job.id).catch(() => undefined);
    setSource(null); setSourceHash(""); setPages([]); setEdits({}); setTextOffsets({}); setSelectedRun(null); setJob(null); setError(""); setUploadProgress(0); setPreviewUpdating(false); sourceBytesRef.current = null; sourcePasswordRef.current = "";
  };
  const continueEditing = () => { setJob(null); setSelectedRun(null); setError(""); setUploadProgress(0); };
  const submit = async () => {
    if (!canSubmit) { setError(!source ? "Add a PDF first." : !changedEdits.length ? "Select and save at least one text replacement." : processingMode === "local" ? "Admin login or activation is required in the Local agent dashboard." : "Server processing is unavailable."); return; }
    const editPayload = [];
    const availableRuns = pages.flatMap((page) => page.runs);
    for (const [runId, replacementText] of changedEdits) {
      const run = availableRuns.find((item) => item.runId === runId);
      if (!run) { setError("A selected text run is no longer available. Reload the PDF and try again."); return; }
      const offset = textOffset(textOffsets[run.runId]);
      editPayload.push({ pageIndex: run.pageIndex, operatorOrdinal: run.ordinal, ...(run.operatorOrdinals?.length > 1 ? { operatorOrdinals: run.operatorOrdinals } : {}), ...(serializedOperatorGroups(run) ? { operatorGroups: serializedOperatorGroups(run) } : {}), runId: run.runId, originalText: run.text || run.originalText, originalTextHash: run.originalTextHash, replacementText, mode: run.mode || "native", offsetX: offset.x, offsetY: offset.y, ...(run.bbox ? { bbox: run.bbox, confidence: run.confidence } : {}) });
    }
    const form = new FormData();
    form.append("tool", "pdf-text-editor"); form.append("source", source, source.name); form.append("sourceHash", sourceHash); form.append("edits", JSON.stringify(editPayload)); if (processingMode === "local") form.append("retention", keepResult ? "keep" : "delete");
    try { setUploadProgress(1); const response = await uploadWithProgress(form, processingMode, setUploadProgress); setUploadProgress(0); const id = response.jobId || response.jobIds?.[0]; setJobMode(processingMode); setJob({ id, status: "queued", progress: 0, stage: "Queued", message: "Waiting for the worker.", logs: [], warnings: [], error: null, result: null }); } catch (submitError) { setUploadProgress(0); setError(submitError instanceof Error ? submitError.message : "The PDF text edit could not be submitted."); }
  };

  return (
    <AppShell>
      <div className="page-heading">
        <div>
          <div className="section-kicker"><span className="kicker-line" /> PDF text tools · Beta</div>
          <h1>PDF text editor</h1>
          <p>Edit existing selectable text while preserving the original PDF graphics, colors, opacity, images, and page layout. Image-only PDFs can be scanned with the bundled OCR engine.</p>
        </div>
        <div className="heading-note"><ShieldCheck size={16} /><span>Only selected text operators change</span></div>
      </div>
      <ToolViewTabs value={activeView} onChange={setActiveView} />
      {activeView === "history" ? <ToolHistory tool="pdf-text-editor" /> : (
        <>
          <ProcessingMode value={processingMode} onChange={setProcessingMode} locations={locations} />
          <div className="capability-strip">
            <div className="capability-main">
              <span className={`capability-dot ${capabilities?.status === "ready" ? "ready" : ""}`} />
              <span>{capabilities?.status === "ready" ? `${processingMode === "local" ? "Local agent" : "Server"} worker online` : "Connecting to processing worker"}</span>
            </div>
            <span>One PDF · 200 MB maximum · OCR fallback · Browser mode disabled</span>
          </div>
          {job ? <PdfTextJobCard initialJob={job} mode={jobMode} onReset={reset} onContinue={continueEditing} keepResult={keepResult} /> : (
            <>
              <section className="tool-card pdf-text-upload-card">
                <div className="card-heading">
                  <div><span className="card-index">01</span><h2>Add one PDF</h2></div>
                  <span className="required-label">Required</span>
                </div>
                <FileDropzone file={source} onFile={selectFile} onClear={reset} variant="pdf" accept="application/pdf,.pdf" label="Drop a PDF here" hint="or click to browse · selectable text or OCR" disabled={loading || Boolean(job)} />
                <div className="limit-row"><span>Maximum file size</span><strong>200 MB</strong></div>
              </section>
              <div className="pdf-text-editor-shell">
                <div className="pdf-text-toolbar">
                  <div>
                    <strong>{ocrDetected && !nativePages ? "Replace OCR-detected text" : "Replace text in your PDF"}</strong>
                    <span>{previewUpdating ? "Rebuilding the real PDF preview…" : source ? `${source.name} · ${pages.length} pages · ${editableCount} editable text runs${ocrDetected && nativePages ? ` · ${ocrPageScope}` : ""}` : "Upload one PDF to begin"}</span>
                  </div>
                  <div className="pdf-text-toolbar-actions">
                    <div className="pdf-zoom-controls" aria-label="Preview zoom">
                      <button className="icon-button" type="button" onClick={() => changePreviewZoom(-0.1)} aria-label="Zoom out" title="Zoom out (-)"><ZoomOut size={16} /></button>
                      <button className="pdf-zoom-value" type="button" onClick={resetPreviewZoom} title="Reset zoom (0)">{Math.round(previewZoom * 100)}%</button>
                      <button className="icon-button" type="button" onClick={() => changePreviewZoom(0.1)} aria-label="Zoom in" title="Zoom in (+)"><ZoomIn size={16} /></button>
                    </div>
                    <button className="primary-button" type="button" onClick={submit} disabled={!canSubmit}>
                      {uploadProgress ? <><LoaderCircle className="spin" size={17} /> Uploading {uploadProgress}%</> : <><Pencil size={17} /> Export edited PDF</>}
                    </button>
                  </div>
                </div>
                {ocrDetected && <div className="pdf-text-ocr-notice"><AlertTriangle size={17} /><div><strong>{nativePages ? "Mixed text mode" : "OCR mode"}</strong><span>{nativePages ? `${ocrPageScope}. The other ${nativePages} page${nativePages === 1 ? " stays" : "s stay"} on the original selectable text path.` : "OCR is used because the PDF does not expose a usable visible text layer or its text is hidden behind page artwork. OCR regions are reconstructed visually with an approximate font; exact original font, opacity, and hidden pixels cannot be recovered."}</span></div></div>}
                <div className="pdf-text-editor-layout">
                  <VirtualizedPdfTextRail pages={pages} onSelect={scrollToPage} />
                  <section className="pdf-text-workspace">
                    {source && !loading && <TextEditPopover run={selectedRun} value={editorValue} onChange={setEditorValue} onSave={saveEdit} onCancel={() => setSelectedRun(null)} onRestore={restoreEdit} />}
                    {loading && <div className="pdf-text-loading"><LoaderCircle className="spin" size={23} /><strong>{loadingMessage}</strong>{ocrProgress > 0 && <span>OCR progress: {ocrProgress}%</span>}</div>}
                    {!loading && !pages.length && <div className="pdf-text-empty"><UploadCloud size={27} /><strong>Upload a PDF to start editing</strong><span>Click a detected text run in the page preview to replace it.</span></div>}
                    {pages.length > 0 && <VirtualizedPdfTextPreview ref={previewVirtualizerRef} pages={pages} selectedRunId={selectedRun?.runId} edits={edits} textOffsets={textOffsets} pdfLibrary={pdfLibrary} previewZoom={previewZoom} previewRevision={previewRevision} onSelectRun={chooseRun} onMoveRun={moveRun} onMoveRunEnd={finishMovingRun} onPinchZoom={setPreviewZoom} />}
                  </section>
                </div>
              </div>
            </>
          )}
          {error && <div className="error-banner"><AlertTriangle size={17} /><span>{error}</span></div>}
          {!job && <div className="trust-row"><div><FileText size={16} /> {ocrDetected && !nativePages ? "OCR regions are visual reconstructions" : ocrDetected ? "Native text stays searchable" : "Searchable text stays searchable"}</div><div><ShieldCheck size={16} /> {ocrDetected ? "Original untouched pages stay unchanged" : "No rasterization or white masking"}</div><div><Pencil size={16} /> Longer text may overflow</div></div>}
        </>
      )}
    </AppShell>
  );
}
