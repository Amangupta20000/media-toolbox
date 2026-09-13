"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FileText, Keyboard, LoaderCircle, Pencil, Printer, RotateCcw, Save, ShieldCheck, UploadCloud, X, ZoomIn, ZoomOut } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { FileDropzone, formatBytes } from "./file-dropzone.jsx";
import { ProcessingMode } from "./processing-mode.jsx";
import { ResultDownloadNote } from "./result-download-note.jsx";
import { ToolHistory, ToolViewTabs } from "./tool-history.jsx";
import { deleteProcessingJob, getProcessingJob, inspectPdfWithOcr, isProcessingLocationReady, processingCapabilities, probeProcessingLocations, uploadWithProgress } from "./processing-client.js";
import { applyRasterTextEdits } from "../lib/pdf-ocr-raster.js";
import { MAX_PDF_BYTES } from "../lib/pdf-limits.js";

async function loadPdfLibrary() {
  const library = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (library.GlobalWorkerOptions) library.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
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

async function inspectPage(pdfPage, pageIndex, pdfLibrary, sourceHash) {
  const [textContent, operatorList] = await Promise.all([pdfPage.getTextContent({ disableCombineTextItems: true }), pdfPage.getOperatorList()]);
  const operators = [];
  let fillColor = "#000000";
  let ordinal = 0;
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    fillColor = fillColorFromOperator(operatorList.fnArray[index], operatorList.argsArray[index], pdfLibrary, fillColor);
    if (operatorList.fnArray[index] !== pdfLibrary.OPS.showText) continue;
    const text = operatorText(operatorList.argsArray[index]);
    operators.push({ ordinal, text, operatorIndex: index, color: fillColor });
    ordinal += 1;
  }
  let itemCursor = 0;
  const runs = [];
  for (const operator of operators) {
    let item = null;
    for (let index = itemCursor; index < textContent.items.length; index += 1) {
      const candidate = textContent.items[index];
      if (!item && normalizeText(candidate.str) === normalizeText(operator.text) && normalizeText(candidate.str)) {
        item = candidate;
        itemCursor = index + 1;
        break;
      }
    }
    if (!item && textContent.items[itemCursor]) item = textContent.items[itemCursor++];
    const text = item?.str || operator.text;
    const sourceText = operator.text || text;
    runs.push({
      ...operator,
      pageIndex,
      text,
      originalText: sourceText,
      originalTextHash: await textHash(sourceText),
      runId: await runId(pageIndex, operator.ordinal, sourceText, sourceHash),
      item,
      color: operator.color,
      editable: Boolean(text && !text.includes("\ufffd")),
      reason: text ? "This text run could not be mapped safely to the PDF text layer." : "This page does not expose selectable text.",
    });
  }
  return { pageIndex, page: pdfPage, runs, textItemCount: textContent.items.length, pageLabel: `Page ${pageIndex + 1}` };
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

function PdfTextPage({ model, selectedRunId, edits, pdfLibrary, previewZoom, onSelectRun, pageRef }) {
  const frameRef = useRef(null);
  const surfaceRef = useRef(null);
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const rerenderRef = useRef(false);
  const [viewport, setViewport] = useState(null);
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
      const availableWidth = surface.clientWidth || Math.max(1, frame.clientWidth - 24);
      const availableHeight = surface.clientHeight || Math.max(1, frame.clientHeight - 24);
      const scale = Math.min(1.35, Math.max(0.45, Math.min(availableWidth / base.width, availableHeight / base.height)));
      // Keep the layout viewport in CSS pixels, but render the canvas at the
      // device pixel ratio so uploaded PDFs stay crisp on Retina/high-density
      // displays. The canvas is then downsampled by CSS without changing the
      // page dimensions or overlay coordinates.
      const pixelRatio = Math.min(3, Math.max(1, Number(window.devicePixelRatio) || 1));
      const nextViewport = model.page.getViewport({ scale });
      const renderViewport = model.page.getViewport({ scale: scale * pixelRatio });
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
            .filter((run) => edits[run.runId] !== undefined)
            .map((run) => ({
              originalText: run.originalText,
              replacementText: edits[run.runId],
              bbox: {
                x0: run.bbox.x0 * canvas.width / Math.max(1, Number(model.imageWidth) || canvas.width),
                y0: run.bbox.y0 * canvas.height / Math.max(1, Number(model.imageHeight) || canvas.height),
                x1: run.bbox.x1 * canvas.width / Math.max(1, Number(model.imageWidth) || canvas.width),
                y1: run.bbox.y1 * canvas.height / Math.max(1, Number(model.imageHeight) || canvas.height),
              },
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
  }, [edits, model, pdfLibrary]);

  const positions = useMemo(() => {
    if (!viewport) return [];
    return model.runs.map((run) => {
      if (run.bbox && model.imageWidth && model.imageHeight) {
        const scaleX = viewport.width / model.imageWidth;
        const scaleY = viewport.height / model.imageHeight;
        return { ...run, left: run.bbox.x0 * scaleX, top: run.bbox.y0 * scaleY, width: Math.max(5, (run.bbox.x1 - run.bbox.x0) * scaleX), height: Math.max(7, (run.bbox.y1 - run.bbox.y0) * scaleY) };
      }
      if (!run.item?.transform) return { ...run, left: 0, top: 0, width: 0, height: 0 };
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
        left: transform[4],
        top: transform[5] - height,
        width: Math.max(5, Number(run.item.width || 0) * viewport.scale),
        height,
        previewFontFamily: font?.name || "sans-serif",
        previewFontWeight: font?.bold || font?.black ? 700 : 400,
        previewFontStyle: font?.italic ? "italic" : "normal",
      };
    });
  }, [model, pdfLibrary, viewport]);

  const baseViewport = model.page.getViewport({ scale: 1 });
  const renderRun = (run) => (
    <Fragment key={run.runId}>
      <button
        type="button"
        className={`pdf-text-run ${run.mode === "ocr" ? "ocr" : ""} ${selectedRunId === run.runId ? "selected" : ""} ${edits[run.runId] !== undefined ? "edited" : ""} ${!run.editable ? "not-editable" : ""}`}
        style={{ left: run.left, top: run.top, width: run.width || undefined, height: run.height || undefined }}
        onClick={() => onSelectRun(run)}
        title={run.editable ? `Edit “${run.text}”` : run.reason}
        aria-label={run.editable ? `Edit text ${run.text}` : `Text not editable: ${run.reason}`}
      />
    </Fragment>
  );
  return <article ref={pageRef} className="pdf-text-page" style={{ "--pdf-text-preview-zoom": previewZoom }} aria-label={model.pageLabel}>
    <div className="pdf-text-page-heading"><strong>{model.pageLabel}</strong><span>{model.runs.length ? `${model.runs.length} ${model.ocr ? "OCR text regions" : "detected text runs"}` : "No editable text detected"}</span></div>
    <div ref={frameRef} className="pdf-text-page-frame">
      <div ref={surfaceRef} className="pdf-text-page-surface" style={{ "--page-ratio": baseViewport.width / baseViewport.height }}>
        <canvas ref={canvasRef} aria-label={`Preview of ${model.pageLabel}`} />
        {positions.map(renderRun)}
      </div>
    </div>
    {!model.runs.length && <div className="pdf-text-page-empty"><AlertTriangle size={17} /><span>{model.ocr ? "OCR could not find readable text on this page." : "This page may be scanned, outlined, annotation-only, or use an unsupported text encoding."}</span></div>}
  </article>;
}

function TextEditPopover({ run, value, onChange, onSave, onCancel, onRestore }) {
  if (!run) return null;
  const overflow = value.length > run.text.length;
  return <div className="pdf-text-edit-popover" role="dialog" aria-label={`Edit ${run.text}`}><div className="pdf-text-edit-heading"><div><span>Selected text</span><strong title={run.text}>{run.text}</strong></div><button className="icon-button" type="button" onClick={onCancel} aria-label="Close text editor" title="Close"><X size={17} /></button></div><input autoFocus value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSave(); if (event.key === "Escape") onCancel(); }} aria-label="Replacement text" /><div className="pdf-text-edit-actions"><button className="primary-button" type="button" onClick={onSave}><Save size={15} /> Save text</button><button className="secondary-button" type="button" onClick={onRestore}><RotateCcw size={15} /> Restore original</button><button className="secondary-button" type="button" onClick={onCancel}>Cancel</button></div>{overflow && <div className="pdf-text-overflow-warning"><AlertTriangle size={15} /><span>This replacement is longer. It will overflow if necessary; surrounding content will not reflow.</span></div>}</div>;
}

function PdfTextJobCard({ initialJob, mode, onReset, onContinue, keepResult }) {
  const [job, setJob] = useState(initialJob);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState("");
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const current = await getProcessingJob(mode, initialJob.id);
        if (!active) return;
        setJob(current);
        if (["queued", "processing"].includes(current.status)) window.setTimeout(poll, 1000);
      } catch (error) {
        if (active) setJob((value) => ({ ...value, status: "failed", error: error instanceof Error ? error.message : "Unable to read PDF text job status." }));
      }
    };
    poll();
    return () => { active = false; };
  }, [initialJob.id, mode]);
  const done = job.status === "completed";
  const failed = job.status === "failed";
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
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
  return <section className={`job-card pdf-job-card ${done ? "success" : failed ? "failed" : ""}`}><div className="job-topline"><span className="job-status-pill">{done ? <CheckCircle2 size={15} /> : failed ? <AlertTriangle size={15} /> : <LoaderCircle className="spin" size={15} />}{done ? "Complete" : failed ? "Needs attention" : "Processing"}</span><span className="job-id">Job {job.id.slice(0, 8)}</span></div><div className="job-icon">{done ? <CheckCircle2 size={30} /> : failed ? <AlertTriangle size={30} /> : <LoaderCircle className="spin" size={30} />}</div><h2>{done ? "Your edited PDF is ready" : failed ? "The PDF could not be edited" : job.stage}</h2><p className="job-message">{failed ? job.error : job.message}</p>{!done && !failed && <><div className="progress-track"><span style={{ width: `${progress}%` }} /></div><div className="progress-meta"><span>{job.stage}</span><strong>{progress}%</strong></div></>}{job.warnings?.length > 0 && <div className="pdf-text-export-warnings"><AlertTriangle size={16} /><div>{job.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div></div>}{done && job.result && <><div className="pdf-text-result-preview"><div className="preview-heading"><span>Edited PDF preview</span><small>{job.result.pageCount} pages</small></div><iframe src={`${job.result.downloadUrl}${job.result.downloadUrl.includes("?") ? "&" : "?"}preview=1`} title={`Preview of ${job.result.filename}`} /></div><div className="result-summary"><div><span>Output</span><strong title={job.result.filename}>{job.result.filename}</strong></div><div><span>Size</span><strong>{formatBytes(job.result.bytes)}</strong></div><div><span>Edits</span><strong>{job.result.editCount}</strong></div><div><span>Method</span><strong>{job.result.method}</strong></div></div><ResultDownloadNote result={job.result} mode={mode} keepResult={keepResult} /></>}{printError && <div className="error-banner"><AlertTriangle size={17} /><span>{printError}</span></div>}<div className="job-actions">{done && job.result && <><a className="primary-button" href={job.result.downloadUrl} download={job.result.filename}><Download size={17} /> Download PDF</a><button className="secondary-button" type="button" onClick={printPdf} disabled={printing}><Printer size={17} /> {printing ? "Preparing print…" : "Print PDF"}</button></>}{(done || failed) && <button className="secondary-button" type="button" onClick={onContinue}><Pencil size={17} /> Continue editing</button>}<button className="secondary-button" type="button" onClick={onReset}><RotateCcw size={17} /> {done || failed ? "Edit another PDF" : "Cancel"}</button></div></section>;
}

export function PdfTextEditor() {
  const [pdfLibrary, setPdfLibrary] = useState(null);
  const [source, setSource] = useState(null);
  const [sourceHash, setSourceHash] = useState("");
  const [pages, setPages] = useState([]);
  const [edits, setEdits] = useState({});
  const [selectedRun, setSelectedRun] = useState(null);
  const [editorValue, setEditorValue] = useState("");
  const [processingMode, setProcessingMode] = useState("server");
  const [jobMode, setJobMode] = useState("server");
  const [locations, setLocations] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [keepResult, setKeepResult] = useState(false);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrDetected, setOcrDetected] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Reading PDF text and building previews…");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeView, setActiveView] = useState("tool");
  const [previewUpdating, setPreviewUpdating] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const pageRefs = useRef(new Map());
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
        setPreviewZoom((current) => Math.min(2, Math.round((current + 0.1) * 10) / 10));
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
    setLoading(true); setSource(file); setPages([]); setEdits({}); setSelectedRun(null); setOcrProgress(0); setOcrDetected(false); setLoadingMessage("Reading PDF text and building previews…"); sourcePasswordRef.current = "";
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
      if (models.some((model) => model.runs.some((run) => run.editable))) {
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
        setOcrDetected(Number(ocrResult.totalRuns) > 0);
        setPages(ocrModels);
        if (!Number(ocrResult.totalRuns)) setError("OCR could not detect readable text in this PDF. Scanned pages may have low resolution or unsupported handwriting.");
      }
    } catch (loadError) {
      setSource(null); setPages([]);
      setError(loadError?.name === "PasswordException" ? "The PDF password was incorrect or the encrypted PDF cannot be edited safely." : loadError instanceof Error ? loadError.message : "The PDF could not be opened for text editing.");
    } finally { setLoading(false); setOcrProgress(0); }
  };

  const editableCount = pages.reduce((total, page) => total + page.runs.filter((run) => run.editable).length, 0);
  const changedEdits = Object.entries(edits).filter(([, value]) => value !== undefined);
  const canSubmit = Boolean(source && sourceHash && changedEdits.length && !loading && !uploadProgress && isProcessingLocationReady(locations, processingMode));

  const chooseRun = (run) => {
    setSelectedRun(run);
    setEditorValue(edits[run.runId] ?? run.text);
    setError(run.editable ? "" : run.reason);
  };
  const changePreviewZoom = (delta) => setPreviewZoom((current) => Math.min(2, Math.max(0.6, Math.round((current + delta) * 10) / 10)));
  const resetPreviewZoom = () => setPreviewZoom(1);
  const refreshEditedPreview = async (nextEdits) => {
    if (!sourceBytesRef.current || !pdfLibrary) return;
    const previewEdits = pages.flatMap((page) => page.runs
      .filter((run) => nextEdits[run.runId] !== undefined)
      .map((run) => ({ pageIndex: run.pageIndex, operatorOrdinal: run.ordinal, replacementText: nextEdits[run.runId], mode: run.mode || "native", ...(run.bbox ? { bbox: run.bbox, confidence: run.confidence, originalText: run.originalText } : {}) })));
    setPreviewUpdating(true);
    try {
      if (pages.some((page) => page.ocr)) {
        // OCR pages are rendered from the original PDF page and edited on the
        // canvas by PdfTextPage. This gives immediate feedback and keeps the
        // preview on the exact same raster path as the worker export.
        setError("");
        return;
      }
      const { createPdfTextPreview } = await import("../lib/pdf-text-preview.js");
      const previewBytes = await createPdfTextPreview(sourceBytesRef.current, previewEdits);
      const previewPdf = await pdfLibrary.getDocument({ data: previewBytes }).promise;
      // PDF.js returns a Promise from getPage(). Passing that Promise into the
      // page model leaves the old canvas in place and prevents an empty
      // replacement from visibly removing the original text.
      const previewPages = await Promise.all(pages.map((page) => previewPdf.getPage(page.pageIndex + 1)));
      setPages((current) => current.map((page) => ({ ...page, page: previewPages[page.pageIndex] })));
      // Force each page renderer to mount against the new PDFDocumentProxy.
      // This avoids retaining a canvas painted from the original document when
      // the page index and layout are otherwise unchanged.
      setPreviewRevision((current) => current + 1);
      setError("");
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "The live PDF preview could not be rebuilt.");
    } finally {
      setPreviewUpdating(false);
    }
  };
  const saveEdit = () => {
    if (!selectedRun) return;
    const value = editorValue;
    const nextEdits = value === selectedRun.text
      ? Object.fromEntries(Object.entries(edits).filter(([key]) => key !== selectedRun.runId))
      : { ...edits, [selectedRun.runId]: value };
    setEdits(nextEdits);
    setSelectedRun(null);
    refreshEditedPreview(nextEdits).catch(() => undefined);
  };
  const restoreEdit = () => {
    if (!selectedRun) return;
    const nextEdits = Object.fromEntries(Object.entries(edits).filter(([key]) => key !== selectedRun.runId));
    setEdits(nextEdits);
    setEditorValue(selectedRun.text);
    refreshEditedPreview(nextEdits).catch(() => undefined);
  };
  const scrollToPage = (pageIndex) => pageRefs.current.get(pageIndex)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const reset = () => {
    if (job && ["queued", "processing"].includes(job.status)) deleteProcessingJob(jobMode, job.id).catch(() => undefined);
    setSource(null); setSourceHash(""); setPages([]); setEdits({}); setSelectedRun(null); setJob(null); setError(""); setUploadProgress(0); setPreviewUpdating(false); sourceBytesRef.current = null; sourcePasswordRef.current = "";
  };
  const continueEditing = () => { setJob(null); setSelectedRun(null); setError(""); setUploadProgress(0); };
  const submit = async () => {
    if (!canSubmit) { setError(!source ? "Add a PDF first." : !changedEdits.length ? "Select and save at least one text replacement." : processingMode === "local" ? "Admin login or activation is required in the Local agent dashboard." : "Server processing is unavailable."); return; }
    const editPayload = [];
    const availableRuns = pages.flatMap((page) => page.runs);
    for (const [runId, replacementText] of changedEdits) {
      const run = availableRuns.find((item) => item.runId === runId);
      if (!run) { setError("A selected text run is no longer available. Reload the PDF and try again."); return; }
      editPayload.push({ pageIndex: run.pageIndex, operatorOrdinal: run.ordinal, runId: run.runId, originalText: run.originalText, originalTextHash: run.originalTextHash, replacementText, mode: run.mode || "native", ...(run.bbox ? { bbox: run.bbox, confidence: run.confidence } : {}) });
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
                    <strong>{ocrDetected ? "Replace OCR-detected text" : "Replace text in your PDF"}</strong>
                    <span>{previewUpdating ? "Rebuilding the real PDF preview…" : source ? `${source.name} · ${pages.length} pages · ${editableCount} ${ocrDetected ? "OCR text regions" : "selectable runs"}` : "Upload one PDF to begin"}</span>
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
                {ocrDetected && <div className="pdf-text-ocr-notice"><AlertTriangle size={17} /><div><strong>OCR mode</strong><span>This PDF has no embedded text. OCR regions are editable, but affected areas are reconstructed visually with an approximate font; exact original font, opacity, and hidden pixels cannot be recovered.</span></div></div>}
                <div className="pdf-text-editor-layout">
                  <aside className="pdf-text-page-rail">
                    <div className="pdf-text-rail-heading"><strong>Pages</strong><span>{pages.length || 0}</span></div>
                    {pages.length ? pages.map((model) => <PdfTextThumbnail key={model.pageIndex} model={model} onSelect={() => scrollToPage(model.pageIndex)} />) : <div className="pdf-text-rail-empty">Thumbnails appear here.</div>}
                  </aside>
                  <section className="pdf-text-workspace">
                    {source && !loading && <TextEditPopover run={selectedRun} value={editorValue} onChange={setEditorValue} onSave={saveEdit} onCancel={() => setSelectedRun(null)} onRestore={restoreEdit} />}
                    {loading && <div className="pdf-text-loading"><LoaderCircle className="spin" size={23} /><strong>{loadingMessage}</strong>{ocrProgress > 0 && <span>OCR progress: {ocrProgress}%</span>}</div>}
                    {!loading && !pages.length && <div className="pdf-text-empty"><UploadCloud size={27} /><strong>Upload a PDF to start editing</strong><span>Click a detected text run in the page preview to replace it.</span></div>}
                    {pages.length > 0 && <div className="pdf-text-preview-scroll" aria-label="PDF page previews">{pages.map((model) => <PdfTextPage key={`${model.pageIndex}-${previewRevision}`} model={model} selectedRunId={selectedRun?.runId} edits={edits} pdfLibrary={pdfLibrary} previewZoom={previewZoom} onSelectRun={chooseRun} pageRef={(element) => { if (element) pageRefs.current.set(model.pageIndex, element); else pageRefs.current.delete(model.pageIndex); }} />)}</div>}
                  </section>
                </div>
              </div>
            </>
          )}
          {error && <div className="error-banner"><AlertTriangle size={17} /><span>{error}</span></div>}
          {!job && <div className="trust-row"><div><FileText size={16} /> {ocrDetected ? "OCR regions are visual reconstructions" : "Searchable text stays searchable"}</div><div><ShieldCheck size={16} /> {ocrDetected ? "Original untouched pages stay unchanged" : "No rasterization or white masking"}</div><div><Pencil size={16} /> Longer text may overflow</div></div>}
        </>
      )}
    </AppShell>
  );
}
