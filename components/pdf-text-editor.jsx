"use client";

import { Fragment, forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { AlertTriangle, Bold, CheckCircle2, Download, FileText, Italic, Keyboard, LoaderCircle, Pencil, Printer, Redo2, RotateCcw, Save, ShieldCheck, Underline, Undo2, UploadCloud, X, ZoomIn, ZoomOut } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { FileDropzone, formatBytes } from "./file-dropzone.jsx";
import { ProcessingMode } from "./processing-mode.jsx";
import { ResultDownloadNote } from "./result-download-note.jsx";
import { downloadFilename, downloadUrlWithFilename, filenameStem, ResultFilenameField } from "./result-filename.jsx";
import { ToolHistory, ToolViewTabs } from "./tool-history.jsx";
import { DismissibleMessage } from "./dismissible-message.jsx";
import { deleteProcessingJob, getProcessingJob, inspectPdfWithOcr, isProcessingLocationReady, processingCapabilities, probeProcessingLocations, uploadWithProgress } from "./processing-client.js";
import { applyRasterTextEdits, inferRasterTextAppearance } from "../lib/pdf-ocr-raster.js";
import { MAX_PDF_BYTES } from "../lib/pdf-limits.js";
import { mergeAdjacentTextRuns } from "../lib/pdf-text-runs.js";
import { graphemeCount } from "../lib/text-metrics.js";
import { takeHistoryEdit } from "./history-edit.js";
import { fontFamilyFromPdfName, hasTextFormat, normalizeTextFormat, scaleTextFormat, textFormatDefaults } from "../lib/pdf-text-format.js";
import { PDF_TEXT_BOX_FONTS } from "../lib/pdf-text-box.js";

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

function textTransform(value) {
  const rawScale = Number(value?.scale);
  const rawRotation = Number(value?.rotation);
  const rawScaleX = Number(value?.scaleX);
  const rawScaleY = Number(value?.scaleY);
  const scale = Number.isFinite(rawScale) ? Math.max(0.25, Math.min(4, rawScale)) : 1;
  const scaleX = Number.isFinite(rawScaleX) ? Math.max(0.25, Math.min(4, rawScaleX)) : scale;
  const scaleY = Number.isFinite(rawScaleY) ? Math.max(0.25, Math.min(4, rawScaleY)) : scale;
  const rotation = Number.isFinite(rawRotation) ? rawRotation : 0;
  return { scale, scaleX, scaleY, rotation };
}

function textFormat(value, run) {
  return normalizeTextFormat(value, run) || textFormatDefaults(run);
}

function hasTextOffset(value) {
  const offset = textOffset(value);
  return Math.abs(offset.x) > 0.01 || Math.abs(offset.y) > 0.01;
}

function hasTextTransform(value) {
  const transform = textTransform(value);
  return Math.abs(transform.scaleX - 1) > 0.001 || Math.abs(transform.scaleY - 1) > 0.001 || Math.abs(transform.rotation) > 0.01;
}

function textOrigin(model, run, pdfLibrary) {
  if (!model?.page || !pdfLibrary?.Util) return null;
  const baseViewport = model.page.getViewport({ scale: 1 });
  let displayCenter;
  if (run.bbox && model.imageWidth && model.imageHeight) {
    displayCenter = [
      ((Number(run.bbox.x0) + Number(run.bbox.x1)) / 2) * baseViewport.width / Math.max(1, Number(model.imageWidth)),
      ((Number(run.bbox.y0) + Number(run.bbox.y1)) / 2) * baseViewport.height / Math.max(1, Number(model.imageHeight)),
    ];
  } else if (run.item?.transform) {
    const transformed = pdfLibrary.Util.transform(baseViewport.transform, run.item.transform);
    const height = Math.max(7, Math.hypot(transformed[2], transformed[3]) || Number(run.item.height) || 12);
    const width = Math.max(0, Number(run.item.width) || 0);
    displayCenter = [transformed[4] + width / 2, transformed[5] - height / 2];
  } else {
    return null;
  }
  const inverse = pdfLibrary.Util.inverseTransform(baseViewport.transform);
  // PDF.js mutates the point array in place and returns undefined. Treating
  // its return value as the transformed point crashes export before the job
  // upload starts.
  const point = [...displayCenter];
  pdfLibrary.Util.applyTransform(point, inverse);
  return point.every(Number.isFinite) ? { x: point[0], y: point[1] } : null;
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
    let sourceFont = null;
    try {
      if (item.fontName && pdfPage.commonObjs.has(item.fontName)) sourceFont = pdfPage.commonObjs.get(item.fontName);
    } catch {
      sourceFont = null;
    }
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
      fontSize: Math.max(1, Number(item.height) || Math.hypot(Number(item.transform?.[2]) || 0, Number(item.transform?.[3]) || 0) || 18),
      color: operator.color,
      // Keep the source font metadata with the run. Formatting one property
      // (for example alignment) must not silently replace the other existing
      // properties with the editor defaults.
      baseFont: sourceFont?.name || "",
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

const PDF_TEXT_THUMBNAIL_QUALITY = 1.25;

function PdfTextThumbnail({ model, onSelect }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    let renderTask;
    const baseViewport = model.page.getViewport({ scale: 1 });
    // Render slightly larger than the displayed thumbnail, then downsample
    // it in CSS so small text and page artwork stay sharper.
    const scale = Math.min(0.22 * PDF_TEXT_THUMBNAIL_QUALITY, (100 * PDF_TEXT_THUMBNAIL_QUALITY) / baseViewport.width);
    const viewport = model.page.getViewport({ scale });
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

function useEstimatedPreviewPageHeight(previewZoom = 1) {
  const [height, setHeight] = useState(890);
  useEffect(() => {
    const update = () => {
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      const frameHeight = Math.min(window.innerHeight * (mobile ? 0.68 : 0.7), mobile ? 520 : 760);
      // The virtual slot only needs to cover the page heading, frame, and
      // the page card's padding. The old 125/130px allowance left a large
      // empty gap after every rendered page, especially on mobile.
      // A zoomed page is allowed to grow beyond the frame instead of creating
      // a nested scrollbar, so reserve a larger virtual slot for the outer
      // preview scroller as the page zoom increases.
      const zoom = Math.max(0.6, Number(previewZoom) || 1);
      setHeight(Math.max(mobile ? 560 : 580, Math.ceil((frameHeight + 60) * zoom)));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [previewZoom]);
  return height;
}

function pointerAngle(event, center) {
  return Math.atan2(event.clientY - center.y, event.clientX - center.x) * 180 / Math.PI;
}

function shortestAngleDelta(value) {
  return ((value + 540) % 360) - 180;
}

const resizeHandleDirections = {
  "top-left": [-1, -1],
  top: [0, -1],
  "top-right": [1, -1],
  right: [1, 0],
  "bottom-right": [1, 1],
  bottom: [0, 1],
  "bottom-left": [-1, 1],
  left: [-1, 0],
};

function selectionHandlePoint(run, appearance, handle, outward = 0) {
  const transform = textTransform(appearance);
  const width = Math.max(4, run.width || 0) * transform.scaleX;
  const height = Math.max(7, run.height || 0) * transform.scaleY;
  const [directionX, directionY] = resizeHandleDirections[handle] || [0, -1];
  return {
    left: Math.max(4, run.width || 0) / 2 + directionX * width / 2,
    top: Math.max(7, run.height || 0) / 2 + directionY * height / 2 - (handle === "top" ? outward : 0),
  };
}

function TextRotationHandle({ run, appearance, surfaceRef, position, onPreviewChange, onChange }) {
  const dragRef = useRef(null);
  const transform = textTransform(appearance);
  const endRotation = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag.moved) onChange?.(run.runId, textTransform({ ...transform, rotation: drag.rotation }));
    onPreviewChange?.(run.runId, null);
  };
  const startRotation = (event) => {
    if (event.button !== 0) return;
    const surface = surfaceRef.current;
    const bounds = surface?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    const center = { x: bounds.left + run.left + Math.max(4, run.width || 0) / 2, y: bounds.top + run.top + Math.max(7, run.height || 0) / 2 };
    const angle = pointerAngle(event, center);
    dragRef.current = { pointerId: event.pointerId, center, lastAngle: angle, rotation: transform.rotation, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveRotation = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && (event.buttons & 1) !== 1) {
      dragRef.current = null;
      onPreviewChange?.(run.runId, null);
      return;
    }
    const angle = pointerAngle(event, drag.center);
    const delta = shortestAngleDelta(angle - drag.lastAngle);
    if (Math.abs(delta) < 0.01) return;
    drag.lastAngle = angle;
    drag.rotation += delta;
    drag.moved = true;
    onPreviewChange?.(run.runId, drag.rotation);
  };
  return <button type="button" className="pdf-text-rotation-handle" style={position} aria-label={`Rotate selected text ${run.text}`} title="Drag to rotate" onPointerDown={startRotation} onPointerMove={moveRotation} onPointerUp={endRotation} onPointerCancel={endRotation} />;
}

function TextResizeHandle({ run, appearance, surfaceRef, handle, position, onPreviewChange, onChange }) {
  const dragRef = useRef(null);
  const transform = textTransform(appearance);
  const isHorizontalSide = handle === "left" || handle === "right";
  const isVerticalSide = handle === "top" || handle === "bottom";
  const direction = resizeHandleDirections[handle] || [1, 1];
  const endResize = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (drag.moved) onChange?.(run.runId, { scaleX: drag.scaleX, scaleY: drag.scaleY });
    onPreviewChange?.(run.runId, null);
  };
  const startResize = (event) => {
    if (event.button !== 0) return;
    const surface = surfaceRef.current;
    const bounds = surface?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    const center = { x: bounds.left + run.left + Math.max(4, run.width || 0) / 2, y: bounds.top + run.top + Math.max(7, run.height || 0) / 2 };
    const radians = transform.rotation * Math.PI / 180;
    const deltaX = event.clientX - center.x;
    const deltaY = event.clientY - center.y;
    const startLocalX = Math.cos(radians) * deltaX + Math.sin(radians) * deltaY;
    const startLocalY = -Math.sin(radians) * deltaX + Math.cos(radians) * deltaY;
    const startDistance = Math.max(1, Math.hypot(startLocalX, startLocalY));
    dragRef.current = { pointerId: event.pointerId, center, startDistance, startLocalX, startLocalY, startScaleX: transform.scaleX, startScaleY: transform.scaleY, scaleX: transform.scaleX, scaleY: transform.scaleY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveResize = (event) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && (event.buttons & 1) !== 1) {
      dragRef.current = null;
      onPreviewChange?.(run.runId, null);
      return;
    }
    const radians = transform.rotation * Math.PI / 180;
    const deltaX = event.clientX - drag.center.x;
    const deltaY = event.clientY - drag.center.y;
    const localX = Math.cos(radians) * deltaX + Math.sin(radians) * deltaY;
    const localY = -Math.sin(radians) * deltaX + Math.cos(radians) * deltaY;
    let scaleX = drag.startScaleX;
    let scaleY = drag.startScaleY;
    if (isHorizontalSide) {
      const startExtent = Math.max(1, direction[0] * drag.startLocalX);
      const extent = Math.max(1, direction[0] * localX);
      scaleX = textTransform({ scaleX: drag.startScaleX * extent / startExtent }).scaleX;
    } else if (isVerticalSide) {
      const startExtent = Math.max(1, direction[1] * drag.startLocalY);
      const extent = Math.max(1, direction[1] * localY);
      scaleY = textTransform({ scaleY: drag.startScaleY * extent / startExtent }).scaleY;
    } else {
      const distance = Math.hypot(localX, localY);
      const factor = distance / drag.startDistance;
      scaleX = textTransform({ scaleX: drag.startScaleX * factor }).scaleX;
      scaleY = textTransform({ scaleY: drag.startScaleY * factor }).scaleY;
    }
    if (Math.abs(scaleX - drag.scaleX) < 0.001 && Math.abs(scaleY - drag.scaleY) < 0.001) return;
    drag.scaleX = scaleX;
    drag.scaleY = scaleY;
    drag.moved = true;
    onPreviewChange?.(run.runId, { scaleX, scaleY });
  };
  return <button type="button" className={`pdf-text-resize-handle ${handle}`} style={position} aria-label={`Resize selected text ${run.text} from the ${handle} handle`} title="Drag to resize" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} />;
}

function PdfTextPage({ model, selectedRunId, edits, textOffsets, textTransforms, textFormats, pdfLibrary, previewZoom, onSelectRun, onMoveRun, onMoveRunEnd, onAppearanceChange, onInferredTextFormat, pageRef }) {
  const frameRef = useRef(null);
  const surfaceRef = useRef(null);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const rerenderRef = useRef(false);
  const [viewport, setViewport] = useState(null);
  const [surfaceSize, setSurfaceSize] = useState(null);
  const [transformPreview, setTransformPreview] = useState(null);
  const rasterPreviewOffsets = model.ocr ? textOffsets : null;
  const rasterPreviewTransforms = useMemo(() => {
    if (!model.ocr || !transformPreview?.runId) return model.ocr ? textTransforms : null;
    return {
      ...textTransforms,
      [transformPreview.runId]: {
        ...textTransforms[transformPreview.runId],
        ...transformPreview,
      },
    };
  }, [model.ocr, textTransforms, transformPreview]);
  useEffect(() => setTransformPreview(null), [selectedRunId]);
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
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      const containerHeight = Math.max(mobile ? 300 : 420, Math.min(window.innerHeight * (mobile ? 0.68 : 0.7), mobile ? 520 : 760));
      // The frame grows with a zoomed page. Keep the fit calculation tied to
      // the viewport-sized minimum, otherwise the grown frame would trigger a
      // feedback loop that keeps enlarging the page on every resize event.
      const availableHeight = Math.max(1, Math.min(frame.clientHeight - 36, containerHeight - 36));
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
          const rasterScale = canvas.width / Math.max(1, base.width);
          const pageUnitScale = 1 / Math.max(1, rasterScale);
          const selectedForInference = model.runs.find((run) => run.runId === selectedRunId && run.editable);
          if (selectedForInference && edits[selectedForInference.runId] === undefined && !hasTextFormat(textFormats[selectedForInference.runId])) {
            const selectedBox = {
              x0: selectedForInference.bbox.x0 * canvas.width / Math.max(1, Number(model.imageWidth) || canvas.width),
              y0: selectedForInference.bbox.y0 * canvas.height / Math.max(1, Number(model.imageHeight) || canvas.height),
              x1: selectedForInference.bbox.x1 * canvas.width / Math.max(1, Number(model.imageWidth) || canvas.width),
              y1: selectedForInference.bbox.y1 * canvas.height / Math.max(1, Number(model.imageHeight) || canvas.height),
            };
            const inferred = inferRasterTextAppearance(canvas, selectedBox, selectedForInference.originalText);
            if (inferred) onInferredTextFormat?.(selectedForInference.runId, {
              fontFamily: fontFamilyFromPdfName(inferred.fontFamily),
              fontSize: inferred.fontSize * pageUnitScale,
              bold: inferred.bold,
              italic: inferred.italic,
              color: inferred.color,
            });
          }
          const pageEdits = model.runs
            .filter((run) => edits[run.runId] !== undefined || hasTextOffset(textOffsets[run.runId]) || hasTextTransform(rasterPreviewTransforms[run.runId]) || hasTextFormat(textFormats[run.runId]))
            .map((run) => {
              const textChanged = edits[run.runId] !== undefined;
              const formatting = hasTextFormat(textFormats[run.runId]) ? textFormat(textFormats[run.runId], run) : null;
              const transform = textTransform(rasterPreviewTransforms[run.runId]);
              const rasterFormatting = formatting ? scaleTextFormat(formatting, rasterScale) : null;
              return {
                runId: run.runId,
                originalText: run.originalText,
                ...(textChanged || formatting ? { replacementText: edits[run.runId] ?? run.originalText } : { moveOnly: true }),
                bbox: {
                  x0: run.bbox.x0 * canvas.width / Math.max(1, Number(model.imageWidth) || canvas.width),
                  y0: run.bbox.y0 * canvas.height / Math.max(1, Number(model.imageHeight) || canvas.height),
                  x1: run.bbox.x1 * canvas.width / Math.max(1, Number(model.imageWidth) || canvas.width),
                  y1: run.bbox.y1 * canvas.height / Math.max(1, Number(model.imageHeight) || canvas.height),
                },
                offsetX: textOffset(textOffsets[run.runId]).x * canvas.width / Math.max(1, base.width),
                offsetY: textOffset(textOffsets[run.runId]).y * canvas.height / Math.max(1, base.height),
                scale: transform.scale,
                scaleX: transform.scaleX,
                scaleY: transform.scaleY,
                rotation: transform.rotation,
                ...(rasterFormatting ? { format: rasterFormatting } : {}),
                confidence: run.confidence,
              };
            });
          applyRasterTextEdits(canvas, pageEdits, {
            onFontMatch: (match) => {
              if (!match?.runId) return;
              onInferredTextFormat?.(match.runId, {
                fontFamily: fontFamilyFromPdfName(match.fontFamily),
                fontSize: Number(match.fontSize) * pageUnitScale,
                bold: Number(match.weight) >= 600,
                italic: Boolean(match.italic),
                color: match.color || undefined,
              });
            },
          });
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
  }, [edits, model, pdfLibrary, previewZoom, rasterPreviewOffsets, rasterPreviewTransforms, selectedRunId, textFormats]);

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
  }, [model, pdfLibrary, textOffsets, textTransforms, viewport]);

  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  useEffect(() => {
    dragRef.current = null;
    suppressClickRef.current = false;
    return () => { dragRef.current = null; };
  }, [model.pageIndex, selectedRunId]);
  const selectTextRun = (run) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onSelectRun(run);
  };
  const startTextDrag = (event, run) => {
    if ((!run.editable && !run.graphic) || event.button !== 0 || event.pointerType !== "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    const offset = textOffset(textOffsets[run.runId]);
    dragRef.current = { runId: run.runId, startX: event.clientX, startY: event.clientY, startOffset: offset, moved: false, pointerId: event.pointerId };
    suppressClickRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const moveTextDrag = (event, run) => {
    const drag = dragRef.current;
    if (!drag || drag.runId !== run.runId || drag.pointerId !== event.pointerId) return;
    // A missed pointerup can leave a captured drag record behind while the
    // pointer continues to hover over the run. Never move text without the
    // primary mouse button still held down.
    if (event.pointerType === "mouse" && (event.buttons & 1) !== 1) {
      dragRef.current = null;
      suppressClickRef.current = false;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      return;
    }
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
  const previewTransform = (runId, patch) => setTransformPreview(patch === null ? null : { runId, ...patch });
  const commitTransform = (runId, patch) => {
    setTransformPreview(null);
    const current = textTransform(textTransforms[runId]);
    onAppearanceChange?.(runId, textTransform({ ...current, ...patch }));
  };
  const renderRun = (run) => {
    const appearance = textTransform(textTransforms[run.runId]);
    const displayAppearance = textTransform(transformPreview?.runId === run.runId ? { ...appearance, ...transformPreview } : appearance);
    const transformable = run.editable || run.graphic;
    const selected = selectedRunId === run.runId && transformable;
    const selectionFrame = selected ? <div className="pdf-text-selection-frame" style={{ left: run.left, top: run.top, width: Math.max(4, run.width || 0), height: Math.max(7, run.height || 0), transform: `rotate(${displayAppearance.rotation}deg)`, transformOrigin: "center center" }}>
      {Object.keys(resizeHandleDirections).map((handle) => <TextResizeHandle key={handle} run={run} appearance={displayAppearance} surfaceRef={surfaceRef} handle={handle} position={{ ...selectionHandlePoint(run, displayAppearance, handle), transform: "translate(-50%, -50%)" }} onPreviewChange={previewTransform} onChange={commitTransform} />)}
      <TextRotationHandle run={run} appearance={displayAppearance} surfaceRef={surfaceRef} onPreviewChange={previewTransform} onChange={commitTransform} position={{ ...selectionHandlePoint(run, displayAppearance, "top", 23), transform: "translate(-50%, -50%)" }} />
      <button
        type="button"
        className={`pdf-text-run ${run.mode === "ocr" ? "ocr" : ""} ${run.graphic ? "graphic" : ""} selected ${edits[run.runId] !== undefined || hasTextOffset(textOffsets[run.runId]) || hasTextTransform(textTransforms[run.runId]) || hasTextFormat(textFormats[run.runId]) ? "edited" : ""}`}
        style={{ left: 0, top: 0, width: "100%", height: "100%", transform: `scale(${displayAppearance.scaleX}, ${displayAppearance.scaleY})`, transformOrigin: "center center" }}
        onClick={() => selectTextRun(run)}
        onPointerDown={(event) => startTextDrag(event, run)}
        onPointerMove={(event) => moveTextDrag(event, run)}
        onPointerUp={(event) => endTextDrag(event, run)}
        onPointerCancel={(event) => endTextDrag(event, run)}
        onLostPointerCapture={(event) => { if (dragRef.current?.pointerId === event.pointerId) { dragRef.current = null; suppressClickRef.current = false; } }}
        title={run.graphic ? `Select graphic “${run.text}”` : `Edit “${run.text}”`}
        aria-label={run.graphic ? `Select graphic ${run.text}` : `Edit text ${run.text}`}
      />
    </div> : <button
      type="button"
      className={`pdf-text-run ${run.mode === "ocr" ? "ocr" : ""} ${run.graphic ? "graphic" : ""} ${edits[run.runId] !== undefined || hasTextOffset(textOffsets[run.runId]) || hasTextTransform(textTransforms[run.runId]) || hasTextFormat(textFormats[run.runId]) ? "edited" : ""} ${!run.editable && !run.graphic ? "not-editable" : ""}`}
      style={{ left: run.left, top: run.top, width: run.width || undefined, height: run.height || undefined, transform: `rotate(${displayAppearance.rotation}deg) scale(${displayAppearance.scaleX}, ${displayAppearance.scaleY})`, transformOrigin: "center center" }}
      onClick={() => selectTextRun(run)}
      onPointerDown={(event) => startTextDrag(event, run)}
      onPointerMove={(event) => moveTextDrag(event, run)}
      onPointerUp={(event) => endTextDrag(event, run)}
      onPointerCancel={(event) => endTextDrag(event, run)}
      onLostPointerCapture={(event) => { if (dragRef.current?.pointerId === event.pointerId) { dragRef.current = null; suppressClickRef.current = false; } }}
      title={run.graphic ? `Select graphic “${run.text}”` : run.editable ? `Edit “${run.text}”` : run.reason}
      aria-label={run.graphic ? `Select graphic ${run.text}` : run.editable ? `Edit text ${run.text}` : `Text not editable: ${run.reason}`}
    />;
    return <Fragment key={run.runId}>{selectionFrame}</Fragment>;
  };
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

const VirtualizedPdfTextPreview = forwardRef(function VirtualizedPdfTextPreview({ pages, selectedRunId, edits, textOffsets, textTransforms, textFormats, pdfLibrary, previewZoom, previewRevision, onSelectRun, onMoveRun, onMoveRunEnd, onAppearanceChange, onInferredTextFormat, onPinchZoom }, ref) {
  const scrollRef = useRef(null);
  const previewZoomRef = useRef(previewZoom);
  const pageHeight = useEstimatedPreviewPageHeight(previewZoom);
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
        return <div key={`${model.pageIndex}-${previewRevision}`} className="pdf-text-virtual-item" style={{ top: `${index * stride}px`, left: 0, width: "100%", height: `${pageHeight}px` }}>
          <PdfTextPage model={model} selectedRunId={selectedRunId} edits={edits} textOffsets={textOffsets} textTransforms={textTransforms} textFormats={textFormats} pdfLibrary={pdfLibrary} previewZoom={previewZoom} onSelectRun={onSelectRun} onMoveRun={onMoveRun} onMoveRunEnd={onMoveRunEnd} onAppearanceChange={onAppearanceChange} onInferredTextFormat={onInferredTextFormat} />
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

function TextEditPopover({ run, value, onChange, onSave, onCancel, onRestore, format, onFormatChange }) {
  if (!run) return null;
  if (!run.editable) {
    const graphic = Boolean(run.graphic);
    return <div className="pdf-text-edit-popover pdf-text-graphic-popover" role="dialog" aria-label={`${graphic ? "Selected graphic" : "Selected non-editable run"} on page ${run.pageIndex + 1}`}>
      <div className="pdf-text-edit-heading"><div><span>{graphic ? "Selected graphic" : "Selected non-editable run"} · Page {run.pageIndex + 1}</span><strong title={run.text}>{run.text}</strong></div><button className="icon-button" type="button" onClick={onCancel} aria-label="Close selection" title="Close"><X size={17} /></button></div>
      <div className="pdf-text-graphic-note"><FileText size={18} /><span>{graphic ? "This OCR-detected symbol or icon is preserved as artwork. Drag it to move it, or use the selection handles to resize and rotate it. Text replacement is disabled." : (run.reason || "This run cannot be edited safely.")}</span></div>
      <div className="pdf-text-edit-actions"><button className="secondary-button" type="button" onClick={onCancel}>Done</button></div>
    </div>;
  }
  const overflow = graphemeCount(value) > graphemeCount(run.text);
  const appearance = textFormat(format, run);
  const styleButton = (key, Icon, label) => <button className="pdf-text-format-button" type="button" aria-label={`${label} selected PDF text`} aria-pressed={Boolean(appearance[key])} title={label} onClick={() => onFormatChange?.({ [key]: !appearance[key] })}><Icon size={14} /></button>;
  return <div className="pdf-text-edit-popover" role="dialog" aria-label={`Edit ${run.text} on page ${run.pageIndex + 1}`}>
    <div className="pdf-text-edit-heading"><div><span>Selected text · Page {run.pageIndex + 1}</span><strong title={run.text}>{run.text}</strong></div><button className="icon-button" type="button" onClick={onCancel} aria-label="Close text editor" title="Close"><X size={17} /></button></div>
    <input autoFocus value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSave(); if (event.key === "Escape") onCancel(); }} aria-label="Replacement text" />
    <div className="pdf-text-format-panel" aria-label="Format existing PDF text">
      <strong>Format selected text</strong>
      <div className="pdf-text-format-row">
        <select value={appearance.fontFamily} aria-label="Font family for selected PDF text" title="Font family" onChange={(event) => onFormatChange?.({ fontFamily: event.target.value })}>{PDF_TEXT_BOX_FONTS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select>
        <input type="number" min="1" max="500" step="1" value={appearance.fontSize} aria-label="Font size for selected PDF text" title="Font size" onChange={(event) => onFormatChange?.({ fontSize: Math.max(1, Math.min(500, Number(event.target.value) || 1)) })} />
        {styleButton("bold", Bold, "Bold")}{styleButton("italic", Italic, "Italic")}{styleButton("underline", Underline, "Underline")}
        <label className="pdf-text-format-color" title="Text color"><span className="sr-only">Text color</span><input type="color" value={appearance.color} aria-label="Text color for selected PDF text" onChange={(event) => onFormatChange?.({ color: event.target.value })} /></label>
      </div>
      <div className="pdf-text-format-row pdf-text-format-secondary-row">
        <label>Align <select value={appearance.alignment} aria-label="Alignment for selected PDF text" onChange={(event) => onFormatChange?.({ alignment: event.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
        <label>Character spacing <input type="number" min="-100" max="100" step="0.1" value={appearance.characterSpacing} aria-label="Character spacing for selected PDF text" onChange={(event) => onFormatChange?.({ characterSpacing: Math.max(-100, Math.min(100, Number(event.target.value) || 0)) })} /></label>
        <label>Line spacing <input type="number" min="0.1" max="10" step="0.1" value={appearance.lineSpacing} aria-label="Line spacing for selected PDF text" onChange={(event) => onFormatChange?.({ lineSpacing: Math.max(0.1, Math.min(10, Number(event.target.value) || 0.1)) })} /></label>
      </div>
      <small>Formatting applies to this PDF text run and is preserved on export. Alignment and line spacing affect replacement text within its original run.</small>
    </div>
    <div className="pdf-text-edit-actions"><button className="primary-button" type="button" onClick={onSave}><Save size={15} /> Save text</button><button className="secondary-button" type="button" onClick={onRestore}><RotateCcw size={15} /> Restore original</button><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button></div>{overflow && <DismissibleMessage className="pdf-text-overflow-warning" resetKey={run.runId}><AlertTriangle size={15} /><span>This replacement is longer. It will overflow if necessary; surrounding content will not reflow.</span></DismissibleMessage>}
  </div>;
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
  return <section className={`job-card pdf-job-card ${done ? "success" : failed ? "failed" : ""}`}><div className="job-topline"><span className="job-status-pill">{done ? <CheckCircle2 size={15} /> : failed ? <AlertTriangle size={15} /> : <LoaderCircle className="spin" size={15} />}{done ? "Complete" : failed ? "Needs attention" : "Processing"}</span><span className="job-id">Job {job.id.slice(0, 8)}</span></div><div className="job-icon">{done ? <CheckCircle2 size={30} /> : failed ? <AlertTriangle size={30} /> : <LoaderCircle className="spin" size={30} />}</div><h2>{done ? "Your edited PDF is ready" : failed ? "The PDF could not be edited" : job.stage}</h2><p className="job-message">{failed ? job.error : job.message}</p>{!done && !failed && <><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="progress-meta"><span>{job.stage}</span><strong>{progress}%</strong></div></>}<PdfTextJobLog logs={job.logs || []} />{job.warnings?.length > 0 && <DismissibleMessage className="pdf-text-export-warnings" resetKey={job.warnings.join("\n")}><AlertTriangle size={16} /><div>{job.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div></DismissibleMessage>}{done && job.result && <><div className="pdf-text-result-preview"><div className="preview-heading"><span>Edited PDF preview</span><small>{job.result.pageCount} pages</small></div><iframe src={`${job.result.downloadUrl}${job.result.downloadUrl.includes("?") ? "&" : "?"}preview=1`} title={`Preview of ${job.result.filename}`} /></div><div className="result-summary"><div><span>Output</span><strong title={job.result.filename}>{job.result.filename}</strong></div><div><span>Size</span><strong>{formatBytes(job.result.bytes)}</strong></div><div><span>Edits</span><strong>{job.result.editCount}</strong></div><div><span>Method</span><strong>{job.result.method}</strong></div></div><ResultDownloadNote result={job.result} mode={mode} keepResult={keepResult} filename={downloadName} /><ResultFilenameField originalFilename={job.result.filename} value={filenameStemValue || filenameStem(job.result.filename)} onChange={setFilenameStemValue} /></>}{printError && <DismissibleMessage className="error-banner" resetKey={printError}><AlertTriangle size={17} /><span>{printError}</span></DismissibleMessage>}<div className="job-actions">{done && job.result && <><a className="primary-button" href={downloadUrlWithFilename(job.result.downloadUrl, downloadName)} download={downloadName}><Download size={17} /> Download PDF</a><button className="secondary-button" type="button" onClick={printPdf} disabled={printing}><Printer size={17} /> {printing ? "Preparing print…" : "Print PDF"}</button></>}{(done || failed) && <button className="secondary-button" type="button" onClick={onContinue}><Pencil size={17} /> Continue editing</button>}<button className="secondary-button" type="button" onClick={onReset}><RotateCcw size={17} /> {done || failed ? "Edit another PDF" : "Cancel"}</button></div></section>;
}

export function PdfTextEditor() {
  const [pdfLibrary, setPdfLibrary] = useState(null);
  const [source, setSource] = useState(null);
  const [sourceHash, setSourceHash] = useState("");
  const [pages, setPages] = useState([]);
  const [edits, setEdits] = useState({});
  const [textOffsets, setTextOffsets] = useState({});
  const [textTransforms, setTextTransforms] = useState({});
  const [textFormats, setTextFormats] = useState({});
  // OCR appearance is inferred from the original pixels and is used only as
  // the starting value in the formatting popover. It is deliberately kept
  // outside the undo/export state until the user changes a control.
  const [inferredTextFormats, setInferredTextFormats] = useState({});
  const [historyVersion, setHistoryVersion] = useState(0);
  const textEditorStateRef = useRef({ edits: {}, textOffsets: {}, textTransforms: {}, textFormats: {} });
  const committedTextStateRef = useRef(textEditorStateRef.current);
  const textHistoryRef = useRef({ past: [], future: [] });
  const [selectedRun, setSelectedRun] = useState(null);
  const [editorValue, setEditorValue] = useState("");
  const [processingMode, setProcessingMode] = useState("server");
  const [jobMode, setJobMode] = useState("server");
  const [locations, setLocations] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [keepResult, setKeepResult] = useState(false);
  const [jobKeepResult, setJobKeepResult] = useState(false);
  const [resultFilenameStem, setResultFilenameStem] = useState("");
  const [previewZoom, setPreviewZoom] = useState(1);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState("Reading PDF text and building previews…");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeView, setActiveView] = useState("tool");
  const [previewUpdating, setPreviewUpdating] = useState(false);
  const [checkingLocation, setCheckingLocation] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [pendingOcrFile, setPendingOcrFile] = useState(null);
  const [ocrMode, setOcrMode] = useState(null);
  const previewVirtualizerRef = useRef(null);
  const previewRequestRef = useRef(0);
  const historyEditLoadedRef = useRef(false);
  const sourceBytesRef = useRef(null);
  const sourcePasswordRef = useRef("");
  const keepResultTouchedRef = useRef(false);
  const resultFilenameTouchedRef = useRef(false);

  const syncTextEditorState = (next) => {
    textEditorStateRef.current = next;
    setEdits(next.edits);
    setTextOffsets(next.textOffsets);
    setTextTransforms(next.textTransforms);
    setTextFormats(next.textFormats);
  };
  const sameTextEditorState = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const commitTextEditorState = (next) => {
    const current = committedTextStateRef.current;
    if (sameTextEditorState(current, next)) {
      syncTextEditorState(next);
      return false;
    }
    textHistoryRef.current = { past: [...textHistoryRef.current.past, current], future: [] };
    committedTextStateRef.current = next;
    syncTextEditorState(next);
    setHistoryVersion((value) => value + 1);
    return true;
  };
  const updateWorkingTextEditorState = (next) => syncTextEditorState(next);
  const clearTextEditorHistory = () => {
    const empty = { edits: {}, textOffsets: {}, textTransforms: {}, textFormats: {} };
    textHistoryRef.current = { past: [], future: [] };
    committedTextStateRef.current = empty;
    syncTextEditorState(empty);
    setInferredTextFormats({});
    setHistoryVersion((value) => value + 1);
  };
  const undoTextEdit = () => {
    const history = textHistoryRef.current;
    const target = history.past.at(-1);
    if (!target) return;
    const current = committedTextStateRef.current;
    history.past = history.past.slice(0, -1);
    history.future = [current, ...history.future];
    committedTextStateRef.current = target;
    syncTextEditorState(target);
    setHistoryVersion((value) => value + 1);
    refreshEditedPreview(target.edits, target.textOffsets, target.textTransforms, target.textFormats).catch(() => undefined);
  };
  const redoTextEdit = () => {
    const history = textHistoryRef.current;
    const target = history.future[0];
    if (!target) return;
    const current = committedTextStateRef.current;
    history.future = history.future.slice(1);
    history.past = [...history.past, current];
    committedTextStateRef.current = target;
    syncTextEditorState(target);
    setHistoryVersion((value) => value + 1);
    refreshEditedPreview(target.edits, target.textOffsets, target.textTransforms, target.textFormats).catch(() => undefined);
  };

  useEffect(() => { loadPdfLibrary().then(setPdfLibrary).catch(() => setError("PDF preview support could not be loaded. Refresh and try again.")); }, []);
  useEffect(() => { probeProcessingLocations().then((value) => { setLocations(value); const preferred = value.server.connected ? "server" : value.local.connected || value.local.ready ? "local" : "server"; setProcessingMode(preferred); setCapabilities(processingCapabilities(value, preferred)); }).catch(() => undefined); }, []);
  useEffect(() => {
    if (!locations || keepResultTouchedRef.current) return;
    setKeepResult(Boolean(locations.local?.connected));
  }, [locations]);
  const defaultResultFilename = useMemo(() => source?.name ? `${filenameStem(source.name)}_edited.pdf` : "edited.pdf", [source?.name]);
  useEffect(() => {
    if (!resultFilenameTouchedRef.current) setResultFilenameStem(filenameStem(defaultResultFilename));
  }, [defaultResultFilename]);
  useEffect(() => setCapabilities(processingCapabilities(locations, processingMode)), [locations, processingMode]);
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (activeView !== "tool" || job || loading) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, button, [contenteditable=\"true\"]")) return;
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase();
        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) redoTextEdit(); else undoTextEdit();
          return;
        }
        if (key === "y") {
          event.preventDefault();
          redoTextEdit();
          return;
        }
      }
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
  }, [activeView, job, loading, historyVersion]);

  const selectFile = (file) => {
    setError("");
    if (!file) return;
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) { setError("Choose a PDF file."); return; }
    if (file.size > MAX_PDF_BYTES) { setError("The PDF must be 200 MB or smaller."); return; }
    if (!pdfLibrary) { setError("PDF preview support is still loading. Try again in a moment."); return; }
    previewRequestRef.current += 1;
    setPendingOcrFile(file);
    setOcrMode(null);
    resultFilenameTouchedRef.current = false;
    setResultFilenameStem("");
    setSource(null); setSourceHash(""); setPages([]); clearTextEditorHistory(); setSelectedRun(null); setEditorValue(""); setJob(null); setOcrProgress(0); setPreviewUpdating(false); sourceBytesRef.current = null; sourcePasswordRef.current = "";
  };

  const loadFile = async (file, requestedOcrMode = "auto") => {
    setError("");
    if (!file) return;
    previewRequestRef.current += 1;
    setPendingOcrFile(null);
    setLoading(true); setSource(file); setPages([]); clearTextEditorHistory(); setSelectedRun(null); setOcrProgress(0); setLoadingMessage("Reading PDF text and building previews…"); sourcePasswordRef.current = "";
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
      if (requestedOcrMode === "embedded") {
        setPages(models);
        setOcrMode("embedded");
        if (!models.some((model) => model.runs.some((run) => run.editable))) setError("OCR was skipped. This PDF does not expose embedded selectable text.");
        return;
      }
      // Automatic mode keeps usable embedded text native, but still scans
      // pages that do not expose an editable text layer. Without this per-page
      // check, a mixed PDF could silently leave image-only pages unsearchable
      // just because another page contained embedded text.
      const ocrPageIndexes = requestedOcrMode === "ocr"
        ? models.map((model) => model.pageIndex)
        : requestedOcrMode === "auto"
          ? models.filter((model) => model.requiresOcr || !model.runs.some((run) => run.editable)).map((model) => model.pageIndex)
          : models.filter((model) => model.requiresOcr).map((model) => model.pageIndex);
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
        setOcrMode("ocr");
        if (!Number(ocrResult.totalRuns)) setError("OCR could not detect readable text on the affected PDF pages. Scanned pages may have low resolution or unsupported handwriting.");
      } else if (requestedOcrMode === "auto" || models.some((model) => model.runs.some((run) => run.editable))) {
        setPages(models);
        setOcrMode(requestedOcrMode === "auto" ? "auto" : "embedded");
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
        setOcrMode("ocr");
        if (!Number(ocrResult.totalRuns)) setError("OCR could not detect readable text in this PDF. Scanned pages may have low resolution or unsupported handwriting.");
      }
    } catch (loadError) {
      setSource(null); setPages([]);
      setError(loadError?.name === "PasswordException" ? "The PDF password was incorrect or the encrypted PDF cannot be edited safely." : loadError instanceof Error ? loadError.message : "The PDF could not be opened for text editing.");
    } finally { setLoading(false); setOcrProgress(0); }
  };

  const chooseOcrMode = (mode) => {
    const file = pendingOcrFile;
    if (!file) return;
    loadFile(file, mode).catch(() => undefined);
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
      if (active) await loadFile(new File([blob], pending.filename || "saved.pdf", { type: pending.mime || "application/pdf" }), "auto");
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
  const textReadModeLabel = ocrMode === "ocr" ? " · OCR selected" : ocrMode === "embedded" ? " · embedded text only" : ocrMode === "auto" ? " · automatic" : "";
  const changedEdits = pages.flatMap((page) => page.runs
    .filter((run) => (run.editable && (edits[run.runId] !== undefined || hasTextOffset(textOffsets[run.runId]) || hasTextTransform(textTransforms[run.runId]) || hasTextFormat(textFormats[run.runId]))) || (run.graphic && (hasTextOffset(textOffsets[run.runId]) || hasTextTransform(textTransforms[run.runId]))))
    .map((run) => {
      const formatting = hasTextFormat(textFormats[run.runId]) ? textFormat(textFormats[run.runId], run) : null;
      const textChanged = edits[run.runId] !== undefined;
      return { runId: run.runId, ...(textChanged || formatting ? { replacementText: edits[run.runId] ?? run.text } : { moveOnly: true }), ...(formatting ? { format: formatting } : {}), ...textTransform(textTransforms[run.runId]) };
    }));
  const canSubmit = Boolean(source && sourceHash && changedEdits.length && !loading && !uploadProgress && !checkingLocation);

  const chooseRun = (run) => {
    // Resolve the clicked run from the current page model. PDF.js page
    // proxies are replaced after a live preview rebuild, so keeping the
    // object supplied by an older render can leave the editor input pointing
    // at a different run than the hitbox under the pointer.
    const currentRun = pages
      .find((page) => page.pageIndex === run.pageIndex)
      ?.runs.find((candidate) => candidate.runId === run.runId) || run;
    setSelectedRun(currentRun);
    setEditorValue(currentRun.editable ? (edits[currentRun.runId] ?? currentRun.text) : "");
    setError(currentRun.editable || currentRun.graphic ? "" : currentRun.reason);
  };
  const changePreviewZoom = (delta) => setPreviewZoom((current) => Math.min(3, Math.max(0.6, Math.round((current + delta) * 10) / 10)));
  const resetPreviewZoom = () => setPreviewZoom(1);
  const refreshEditedPreview = async (nextEdits, nextOffsets = textOffsets, nextTransforms = textTransforms, nextFormats = textFormats) => {
    if (!sourceBytesRef.current || !pdfLibrary) return;
    const requestId = previewRequestRef.current + 1;
    previewRequestRef.current = requestId;
    // Snapshot both inputs before any async work. React may commit a newer
    // page model while PDF.js is rebuilding; using the live ref for bytes and
    // the old render's page array together can otherwise paint a stale page.
    const sourceBytes = sourceBytesRef.current.slice();
    const pageModels = pages.slice();
    const previewEdits = pageModels.flatMap((page) => page.runs
      .filter((run) => nextEdits[run.runId] !== undefined || hasTextOffset(nextOffsets[run.runId]) || hasTextTransform(nextTransforms[run.runId]) || hasTextFormat(nextFormats[run.runId]))
      .map((run) => {
        const offset = textOffset(nextOffsets[run.runId]);
        const textChanged = nextEdits[run.runId] !== undefined;
        const formatting = hasTextFormat(nextFormats[run.runId]) ? textFormat(nextFormats[run.runId], run) : null;
        const moveOnly = !textChanged && !formatting;
        const transform = textTransform(nextTransforms[run.runId]);
        const model = pageModels.find((candidate) => candidate.pageIndex === run.pageIndex);
        const origin = textOrigin(model, run, pdfLibrary);
        return { pageIndex: run.pageIndex, operatorOrdinal: run.ordinal, ...(run.operatorOrdinals?.length > 1 ? { operatorOrdinals: run.operatorOrdinals } : {}), ...(serializedOperatorGroups(run) ? { operatorGroups: serializedOperatorGroups(run) } : {}), originalText: run.text || run.originalText, ...(moveOnly ? { moveOnly: true } : { replacementText: nextEdits[run.runId] ?? run.text ?? run.originalText }), ...(formatting ? { format: formatting } : {}), ...(run.item?.width ? { boxWidth: Number(run.item.width) } : {}), mode: run.mode || "native", offsetX: offset.x, offsetY: offset.y, scale: transform.scale, scaleX: transform.scaleX, scaleY: transform.scaleY, rotation: transform.rotation, ...(origin ? { originX: origin.x, originY: origin.y } : {}), ...(run.bbox ? { bbox: run.bbox, confidence: run.confidence } : {}) };
      }));
    setPreviewUpdating(true);
    try {
      const nativePreviewEdits = previewEdits.filter((edit) => edit.mode !== "ocr");
      const { createPdfTextPreview } = await import("../lib/pdf-text-preview.js");
      // An empty native edit list intentionally rebuilds from the source too.
      // This is required when the user restores the original text; simply
      // returning would leave the previous edited PDF.js page mounted.
      const previewBytes = await createPdfTextPreview(sourceBytes, nativePreviewEdits);
      const previewPdf = await pdfLibrary.getDocument({ data: previewBytes }).promise;
      // PDF.js returns a Promise from getPage(). Passing that Promise into the
      // page model leaves the old canvas in place and prevents an empty
      // replacement from visibly removing the original text.
      const previewPages = await Promise.all(pageModels.map((page) => previewPdf.getPage(page.pageIndex + 1)));
      if (requestId !== previewRequestRef.current) {
        previewPdf.cleanup?.();
        return;
      }
      const previewPagesByIndex = new Map(pageModels.map((page, index) => [page.pageIndex, previewPages[index]]));
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
  const moveRun = (runId, offset) => updateWorkingTextEditorState({ ...textEditorStateRef.current, textOffsets: { ...textEditorStateRef.current.textOffsets, [runId]: textOffset(offset) } });
  const finishMovingRun = (runId, offset) => {
    const next = { ...textEditorStateRef.current, textOffsets: { ...textEditorStateRef.current.textOffsets, [runId]: textOffset(offset) } };
    commitTextEditorState(next);
    refreshEditedPreview(next.edits, next.textOffsets, next.textTransforms, next.textFormats).catch(() => undefined);
  };
  const updateTextTransform = (runId, value) => {
    const next = { ...textEditorStateRef.current, textTransforms: { ...textEditorStateRef.current.textTransforms, [runId]: textTransform(value) } };
    commitTextEditorState(next);
    refreshEditedPreview(next.edits, next.textOffsets, next.textTransforms, next.textFormats).catch(() => undefined);
  };
  const updateTextFormat = (runId, changes) => {
    const run = pages.flatMap((page) => page.runs).find((item) => item.runId === runId);
    if (!run) return;
    const current = textFormat(textEditorStateRef.current.textFormats[runId] || inferredTextFormats[runId], run);
    const next = { ...textEditorStateRef.current, textFormats: { ...textEditorStateRef.current.textFormats, [runId]: textFormat({ ...current, ...changes }, run) } };
    commitTextEditorState(next);
    refreshEditedPreview(next.edits, next.textOffsets, next.textTransforms, next.textFormats).catch(() => undefined);
  };
  const updateInferredTextFormat = (runId, changes) => {
    const run = pages.flatMap((page) => page.runs).find((item) => item.runId === runId);
    if (!run || textEditorStateRef.current.textFormats[runId]) return;
    setInferredTextFormats((currentFormats) => {
      const next = textFormat({ ...textFormat(currentFormats[runId], run), ...changes }, run);
      if (JSON.stringify(currentFormats[runId]) === JSON.stringify(next)) return currentFormats;
      return { ...currentFormats, [runId]: next };
    });
  };
  const saveEdit = () => {
    if (!selectedRun) return;
    const value = editorValue;
    const next = { ...textEditorStateRef.current, edits: value === selectedRun.text ? Object.fromEntries(Object.entries(textEditorStateRef.current.edits).filter(([key]) => key !== selectedRun.runId)) : { ...textEditorStateRef.current.edits, [selectedRun.runId]: value } };
    commitTextEditorState(next);
    setSelectedRun(null);
    refreshEditedPreview(next.edits, next.textOffsets, next.textTransforms, next.textFormats).catch(() => undefined);
  };
  const restoreEdit = () => {
    if (!selectedRun) return;
    const next = {
      edits: Object.fromEntries(Object.entries(textEditorStateRef.current.edits).filter(([key]) => key !== selectedRun.runId)),
      textOffsets: Object.fromEntries(Object.entries(textEditorStateRef.current.textOffsets).filter(([key]) => key !== selectedRun.runId)),
      textTransforms: Object.fromEntries(Object.entries(textEditorStateRef.current.textTransforms).filter(([key]) => key !== selectedRun.runId)),
      textFormats: Object.fromEntries(Object.entries(textEditorStateRef.current.textFormats).filter(([key]) => key !== selectedRun.runId)),
    };
    commitTextEditorState(next);
    setEditorValue(selectedRun.text);
    refreshEditedPreview(next.edits, next.textOffsets, next.textTransforms, next.textFormats).catch(() => undefined);
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
    keepResultTouchedRef.current = false;
    resultFilenameTouchedRef.current = false;
    setPendingOcrFile(null); setOcrMode(null); setSource(null); setSourceHash(""); setPages([]); clearTextEditorHistory(); setSelectedRun(null); setJob(null); setJobKeepResult(false); setResultFilenameStem(""); setError(""); setUploadProgress(0); setPreviewUpdating(false); setCheckingLocation(false); sourceBytesRef.current = null; sourcePasswordRef.current = "";
  };
  const continueEditing = () => { setJob(null); setJobKeepResult(false); setSelectedRun(null); setError(""); setUploadProgress(0); };
  const submit = async ({ saveToDevice = false } = {}) => {
    if (!canSubmit) { setError(!source ? "Add a PDF first." : !changedEdits.length ? "Select and save at least one text replacement." : "The PDF is still being prepared. Try again in a moment."); return; }
    // The initial location probe can finish after the PDF has loaded. Probe
    // once more at export time so a worker that has just started is not left
    // behind a stale disabled state, while still reporting a useful error when
    // the selected processing location is genuinely unavailable.
    let exportLocations = locations;
    if (!isProcessingLocationReady(exportLocations, processingMode)) {
      setError("");
      setCheckingLocation(true);
      try {
        exportLocations = await probeProcessingLocations();
        setLocations(exportLocations);
      } catch (probeError) {
        setCheckingLocation(false);
        setError(probeError instanceof Error ? probeError.message : "The selected processing worker could not be reached.");
        return;
      }
      setCheckingLocation(false);
      if (!isProcessingLocationReady(exportLocations, processingMode)) {
        const locationError = exportLocations?.[processingMode]?.error;
        setError(locationError || (processingMode === "local" ? "The Local agent is not ready. Start and authorize it, then try again." : "The Server worker is not ready. Start the worker, then try again."));
        return;
      }
    }
    const editPayload = [];
    const availableRuns = pages.flatMap((page) => page.runs);
    for (const { runId, replacementText, moveOnly, format } of changedEdits) {
      const run = availableRuns.find((item) => item.runId === runId);
      if (!run) { setError("A selected text run is no longer available. Reload the PDF and try again."); return; }
      const offset = textOffset(textOffsets[run.runId]);
      const transform = textTransform(textTransforms[run.runId]);
      const model = pages.find((page) => page.pageIndex === run.pageIndex);
      const origin = textOrigin(model, run, pdfLibrary);
      editPayload.push({ pageIndex: run.pageIndex, operatorOrdinal: run.ordinal, ...(run.operatorOrdinals?.length > 1 ? { operatorOrdinals: run.operatorOrdinals } : {}), ...(serializedOperatorGroups(run) ? { operatorGroups: serializedOperatorGroups(run) } : {}), runId: run.runId, originalText: run.text || run.originalText, originalTextHash: run.originalTextHash, ...(moveOnly ? { moveOnly: true } : { replacementText: replacementText ?? run.text }), ...(format ? { format } : {}), ...(run.item?.width ? { boxWidth: Number(run.item.width) } : {}), mode: run.mode || "native", offsetX: offset.x, offsetY: offset.y, scale: transform.scale, scaleX: transform.scaleX, scaleY: transform.scaleY, rotation: transform.rotation, ...(origin ? { originX: origin.x, originY: origin.y } : {}), ...(run.bbox ? { bbox: run.bbox, confidence: run.confidence } : {}) });
    }
    const effectiveKeepResult = processingMode === "local" && (keepResult || saveToDevice);
    const form = new FormData();
    form.append("tool", "pdf-text-editor"); form.append("source", source, source.name); form.append("sourceHash", sourceHash); form.append("edits", JSON.stringify(editPayload)); form.append("filename", downloadFilename(resultFilenameStem || filenameStem(defaultResultFilename), defaultResultFilename)); if (processingMode === "local") form.append("retention", effectiveKeepResult ? "keep" : "delete");
    try { setUploadProgress(1); const response = await uploadWithProgress(form, processingMode, setUploadProgress); setUploadProgress(0); const id = response.jobId || response.jobIds?.[0]; setJobMode(processingMode); setJobKeepResult(effectiveKeepResult); setJob({ id, status: "queued", progress: 0, stage: "Queued", message: effectiveKeepResult ? "Waiting for the worker. The completed PDF will be saved to this device." : "Waiting for the worker.", logs: [], warnings: [], error: null, result: null }); } catch (submitError) { setUploadProgress(0); setError(submitError instanceof Error ? submitError.message : "The PDF text edit could not be submitted."); }
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
          {job ? <PdfTextJobCard initialJob={job} mode={jobMode} onReset={reset} onContinue={continueEditing} keepResult={jobKeepResult} /> : (
            <>
              <section className="tool-card pdf-text-upload-card">
                <div className="card-heading">
                  <div><span className="card-index">01</span><h2>Add one PDF</h2></div>
                  <span className="required-label">Required</span>
                </div>
                <FileDropzone file={source || pendingOcrFile} onFile={selectFile} onClear={reset} variant="pdf" accept="application/pdf,.pdf" label="Drop a PDF here" hint="or click to browse · choose automatic, embedded text, or OCR after upload" disabled={loading || Boolean(job)} />
                <div className="limit-row"><span>Maximum file size</span><strong>200 MB</strong></div>
                {pendingOcrFile && <div className="pdf-text-ocr-choice" role="dialog" aria-labelledby="pdf-text-ocr-choice-title">
                  <div className="pdf-text-ocr-choice-copy"><strong id="pdf-text-ocr-choice-title">How should this PDF be read?</strong><span>Automatic keeps usable embedded text and runs OCR only on pages that need visual text detection.</span></div>
                  <div className="pdf-text-ocr-choice-actions"><button className="primary-button" type="button" onClick={() => chooseOcrMode("auto")}><FileText size={16} /> Automatic</button><button className="secondary-button" type="button" onClick={() => chooseOcrMode("ocr")}><Pencil size={16} /> Use OCR</button><button className="secondary-button" type="button" onClick={() => chooseOcrMode("embedded")}><FileText size={16} /> Use embedded text only</button></div>
                  <small>OCR makes detected words and symbol-like graphics selectable. Symbols stay artwork and can be moved, resized, or rotated, but their text cannot be replaced.</small>
                </div>}
              </section>
              <div className="pdf-text-editor-shell">
                <div className="pdf-text-toolbar">
                  <div>
                    <strong>{ocrDetected && !nativePages ? "Replace OCR-detected text" : "Replace text in your PDF"}</strong>
                    <span>{previewUpdating ? "Rebuilding the real PDF preview…" : source ? `${source.name} · ${pages.length} pages · ${editableCount} editable text runs${textReadModeLabel}${ocrDetected && nativePages ? ` · ${ocrPageScope}` : ""}` : "Upload one PDF to begin"}</span>
                  </div>
                  <div className="pdf-text-toolbar-actions">
                    <div className="pdf-text-history-controls" aria-label="Text editor history">
                      <button className="icon-button" type="button" onClick={undoTextEdit} disabled={!textHistoryRef.current.past.length} aria-label="Undo PDF text editor change" title="Undo (⌘/Ctrl+Z)"><Undo2 size={16} /></button>
                      <button className="icon-button" type="button" onClick={redoTextEdit} disabled={!textHistoryRef.current.future.length} aria-label="Redo PDF text editor change" title="Redo (⌘/Ctrl+Y)"><Redo2 size={16} /></button>
                    </div>
                    <div className="pdf-zoom-controls" aria-label="Preview zoom">
                      <button className="icon-button" type="button" onClick={() => changePreviewZoom(-0.1)} aria-label="Zoom out" title="Zoom out (-)"><ZoomOut size={16} /></button>
                      <button className="pdf-zoom-value" type="button" onClick={resetPreviewZoom} title="Reset zoom (0)">{Math.round(previewZoom * 100)}%</button>
                      <button className="icon-button" type="button" onClick={() => changePreviewZoom(0.1)} aria-label="Zoom in" title="Zoom in (+)"><ZoomIn size={16} /></button>
                    </div>
                    <button className="primary-button" type="button" onClick={submit} disabled={!canSubmit}>
                      {uploadProgress ? <><LoaderCircle className="spin" size={17} /> Uploading {uploadProgress}%</> : checkingLocation ? <><LoaderCircle className="spin" size={17} /> Checking worker…</> : <><Pencil size={17} /> Export edited PDF</>}
                    </button>
                    {processingMode === "local" && <button className="secondary-button pdf-save-button" type="button" onClick={() => submit({ saveToDevice: true })} disabled={!canSubmit} title="Process the PDF and keep it in the Local agent Results folder"><Save size={17} /> Save to device</button>}
                  </div>
                </div>
                {processingMode === "local" && <div className="pdf-retention-row pdf-text-retention-row"><label className="keep-result-check pdf-retention-check"><input type="checkbox" checked={keepResult} onChange={(event) => { keepResultTouchedRef.current = true; setKeepResult(event.target.checked); }} /><span>Keep final result on this device</span></label><span className="pdf-retention-status" aria-live="polite">{keepResult ? "The completed PDF will be saved to the Local agent Results folder." : "Exported PDFs are temporary unless you choose Save to device."}</span><ResultFilenameField originalFilename={defaultResultFilename} value={resultFilenameStem || filenameStem(defaultResultFilename)} label="Saved PDF name" description="This name is used for export and for PDF text editor History when the result is retained." onChange={(value) => { resultFilenameTouchedRef.current = true; setResultFilenameStem(filenameStem(value)); }} /></div>}
                {ocrDetected && <DismissibleMessage className="pdf-text-ocr-notice" resetKey={`${nativePages}-${ocrPageScope}`}><AlertTriangle size={17} /><div><strong>{nativePages ? "Mixed text mode" : "OCR mode"}</strong><span>{nativePages ? `${ocrPageScope}. The other ${nativePages} page${nativePages === 1 ? " stays" : "s stay"} on the original selectable text path.` : "OCR is used because the PDF does not expose a usable visible text layer or its text is hidden behind page artwork. OCR regions are reconstructed visually with an approximate font; exact original font, opacity, and hidden pixels cannot be recovered."}</span></div></DismissibleMessage>}
                <div className="pdf-text-editor-layout">
                  <VirtualizedPdfTextRail pages={pages} onSelect={scrollToPage} />
                  <section className="pdf-text-workspace">
                    {source && !loading && <TextEditPopover run={selectedRun} value={editorValue} onChange={setEditorValue} onSave={saveEdit} onCancel={() => setSelectedRun(null)} onRestore={restoreEdit} format={selectedRun ? { ...inferredTextFormats[selectedRun.runId], ...textFormats[selectedRun.runId] } : undefined} onFormatChange={(value) => selectedRun && updateTextFormat(selectedRun.runId, value)} appearance={selectedRun ? textTransforms[selectedRun.runId] : undefined} onAppearanceChange={(value) => selectedRun && updateTextTransform(selectedRun.runId, value)} />}
                    {loading && <div className="pdf-text-loading"><LoaderCircle className="spin" size={23} /><strong>{loadingMessage}</strong>{ocrProgress > 0 && <span>OCR progress: {ocrProgress}%</span>}</div>}
                    {!loading && !pages.length && <div className="pdf-text-empty"><UploadCloud size={27} /><strong>Upload a PDF to start editing</strong><span>Click a detected text run in the page preview to replace it.</span></div>}
                    {pages.length > 0 && <VirtualizedPdfTextPreview ref={previewVirtualizerRef} pages={pages} selectedRunId={selectedRun?.runId} edits={edits} textOffsets={textOffsets} textTransforms={textTransforms} textFormats={textFormats} pdfLibrary={pdfLibrary} previewZoom={previewZoom} previewRevision={previewRevision} onSelectRun={chooseRun} onMoveRun={moveRun} onMoveRunEnd={finishMovingRun} onAppearanceChange={updateTextTransform} onInferredTextFormat={updateInferredTextFormat} onPinchZoom={setPreviewZoom} />}
                  </section>
                </div>
              </div>
            </>
          )}
          {error && <DismissibleMessage className="error-banner" resetKey={error}><AlertTriangle size={17} /><span>{error}</span></DismissibleMessage>}
          {!job && <div className="trust-row"><div><FileText size={16} /> {ocrDetected && !nativePages ? "OCR regions are visual reconstructions" : ocrDetected ? "Native text stays searchable" : "Searchable text stays searchable"}</div><div><ShieldCheck size={16} /> {ocrDetected ? "Original untouched pages stay unchanged" : "No rasterization or white masking"}</div><div><Pencil size={16} /> Longer text may overflow</div></div>}
        </>
      )}
    </AppShell>
  );
}
