"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Download, FileCheck2, Info, LoaderCircle, RotateCcw, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { FileDropzone, formatBytes } from "./file-dropzone.jsx";
import { takeHistoryEdit } from "./history-edit.js";
import { ProcessingMode } from "./processing-mode.jsx";
import { ResultDownloadNote } from "./result-download-note.jsx";
import { ToolHistory, ToolViewTabs } from "./tool-history.jsx";
import { deleteProcessingJob, getProcessingJob, isProcessingLocationReady, processingCapabilities, probeProcessingLocations, uploadWithProgress } from "./processing-client.js";

const imageFormats = [
  ["original", "Original", "Keep encoded format"],
  ["jpeg", "JPG", "Small, shareable files"],
  ["png", "PNG", "Graphics & transparency"],
  ["heic", "HEIC", "Efficient photo storage"],
  ["tiff", "TIFF", "Editing & archival"],
  ["gif", "GIF", "Legacy compatibility"],
  ["bmp", "BMP", "Legacy software"],
];

const imageAccept = ".jpg,.jpeg,.png,.heic,.heif,.tif,.tiff,.gif,.bmp";

const imageMethods = [
  ["auto", "Auto", "Use the best available worker path", "recommended"],
  ["imagemagick", "ImageMagick", "Portable Linux conversion + libheif", "linux"],
  ["sips", "macOS sips", "Local Mac fallback", "macOS"],
];

export function ToolPage({ tool }) {
  const isImage = tool === "image-converter";
  const [source, setSource] = useState(null);
  const [reference, setReference] = useState(null);
  const [format, setFormat] = useState("original");
  const [method, setMethod] = useState("auto");
  const [maxSizeKb, setMaxSizeKb] = useState("");
  const [jpegConfirmed, setJpegConfirmed] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [jobId, setJobId] = useState(null);
  const [jobMode, setJobMode] = useState("server");
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [capabilities, setCapabilities] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewError, setPreviewError] = useState(false);
  const [locations, setLocations] = useState(null);
  const [processingMode, setProcessingMode] = useState("server");
  const [keepResult, setKeepResult] = useState(false);
  const [activeView, setActiveView] = useState("tool");

  useEffect(() => {
    let active = true;
    probeProcessingLocations().then((value) => {
      if (!active) return;
      setLocations(value);
      const preferred = value.server.connected ? "server" : value.local.connected ? "local" : "server";
      setProcessingMode(preferred);
      setCapabilities(processingCapabilities(value, preferred));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => setCapabilities(processingCapabilities(locations, processingMode)), [locations, processingMode]);

  useEffect(() => {
    setPreviewError(false);
    if (!isImage || !source) {
      setPreviewUrl("");
      return undefined;
    }
    const objectUrl = URL.createObjectURL(source);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [isImage, source]);

  useEffect(() => {
    if (!jobId) return undefined;
    let active = true;
    const poll = async () => {
      try {
        const current = await getProcessingJob(jobMode, jobId);
        if (!active) return;
        setJob(current);
        if (current.status === "queued" || current.status === "processing") window.setTimeout(poll, 1000);
      } catch (pollError) {
        if (active) setError(pollError instanceof Error ? pollError.message : "Unable to read job status.");
      }
    };
    poll();
    return () => { active = false; };
  }, [jobId, jobMode]);

  const busy = Boolean(jobId && job && (job.status === "queued" || job.status === "processing"));
  const canSubmit = Boolean(source) && !busy && !uploadProgress;
  const title = isImage ? "Image conversion" : "Video repair";
  const eyebrow = isImage ? "Format & size" : "Recovery & salvage";
  const description = isImage ? "Convert image data between formats while keeping the original pixel dimensions intact." : "Give damaged or unsupported footage a layered recovery pass without touching the original.";
  const heicReady = capabilities?.image?.heic || capabilities?.image?.sips;
  const imageMagickReady = capabilities?.image?.imagemagick !== false;
  const sipsReady = capabilities?.image?.sips === true;
  const serverReferenceReady = capabilities?.video?.defaultReference === true;

  const reset = () => {
    if (jobId && job && (job.status === "queued" || job.status === "processing")) deleteProcessingJob(jobMode, jobId).catch(() => undefined);
    setSource(null); setReference(null); setFormat("original"); setMethod("auto"); setMaxSizeKb(""); setJpegConfirmed(false); setUploadProgress(0); setJobId(null); setJob(null); setError(""); setPreviewUrl(""); setPreviewError(false); setKeepResult(false);
  };

  const handleSourceFile = (file) => {
    setSource(file);
    setPreviewUrl("");
    setPreviewError(false);
    setFormat("original");
    setMaxSizeKb("");
    setJpegConfirmed(false);
    setError("");
  };

  useEffect(() => {
    const pending = takeHistoryEdit(tool);
    if (!pending?.downloadUrl) return undefined;
    let active = true;
    fetch(pending.downloadUrl, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("The saved result could not be reopened.");
      const blob = await response.blob();
      if (!active) return;
      handleSourceFile(new File([blob], pending.filename || "saved-result", { type: pending.mime || blob.type || "application/octet-stream" }));
    }).catch((loadError) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "The saved result could not be reopened.");
    });
    return () => { active = false; };
  }, [tool]);

  const submit = async () => {
    setError("");
    if (!source) { setError(`Choose a ${isImage ? "source image" : "video"} first.`); return; }
    if (!isProcessingLocationReady(locations, processingMode)) { setError(processingMode === "local" ? "Start and pair the Local agent before processing." : "Server processing is unavailable. Choose Local agent after pairing it."); return; }
    if (isImage && maxSizeKb && (!/^\d+$/.test(maxSizeKb) || Number(maxSizeKb) <= 0)) { setError("Enter a positive whole number of KB."); return; }
    if (isImage && format === "jpeg" && !jpegConfirmed) { setError("Confirm the JPEG transparency warning before continuing."); return; }
    const form = new FormData();
    form.append("tool", tool);
      form.append("source", source, source.name);
    if (isImage) {
      form.append("format", format);
      form.append("method", method);
      if (maxSizeKb) form.append("maxSizeKb", maxSizeKb);
      form.append("jpegConfirmed", String(jpegConfirmed));
    } else if (reference) form.append("reference", reference, reference.name);
    if (processingMode === "local") form.append("retention", keepResult ? "keep" : "delete");
    try {
      setUploadProgress(1);
      const response = await uploadWithProgress(form, processingMode, setUploadProgress);
      setUploadProgress(0);
      setJobMode(processingMode);
      setJobId(response.jobId);
      setJob({ id: response.jobId, status: "queued", progress: 0, stage: "Queued", message: "Waiting for the worker.", logs: [], warnings: [], error: null, result: null });
    } catch (submitError) {
      setUploadProgress(0);
      setError(submitError instanceof Error ? submitError.message : "The upload failed.");
    }
  };

  return <AppShell>
    <div className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> {eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="heading-note"><ShieldCheck size={16} /><span>Original files stay untouched</span></div></div>
    <ToolViewTabs value={activeView} onChange={setActiveView} />
    {activeView === "history" ? <ToolHistory tool={tool} /> : <>
    <ProcessingMode value={processingMode} onChange={setProcessingMode} locations={locations} />
    <div className="capability-strip"><div className="capability-main"><span className={`capability-dot ${capabilities?.status === "ready" ? "ready" : ""}`} /><span>{capabilities?.status === "ready" ? `${processingMode === "local" ? "Local agent" : "Server"} worker online` : "Connecting to processing worker"}</span></div>{isImage ? <span>{heicReady ? (capabilities?.image?.heic ? "HEIC enabled" : "HEIC enabled via local fallback") : capabilities?.status === "ready" ? "HEIC unavailable" : "HEIC capability checking"}</span> : <span>{capabilities?.video?.untrunc ? (serverReferenceReady ? "Reference recovery + fallback" : "Reference recovery · upload a reference") : capabilities?.status === "ready" ? "FFmpeg recovery enabled · reference recovery unavailable" : "Video capabilities checking"}</span>}</div>
    {job ? <JobStatusCard job={job} isImage={isImage} mode={jobMode} keepResult={keepResult} onReset={reset} /> : <div className="workspace-grid">
      <section className="tool-card primary-card"><div className="card-heading"><div><span className="card-index">01</span><h2>{isImage ? "Add an image" : "Add a damaged video"}</h2></div><span className="required-label">Required</span></div><FileDropzone file={source} onFile={isImage ? handleSourceFile : (file) => { setSource(file); setError(""); }} onClear={() => { setSource(null); setPreviewUrl(""); setPreviewError(false); }} variant={isImage ? "image" : "video"} accept={isImage ? imageAccept : "video/*,.mkv,.webm,.avi,.3gp"} label={isImage ? "Drop an image here" : "Drop a video here"} hint="or click to browse from your device" disabled={Boolean(uploadProgress)} />{isImage && source && previewUrl && <div className="image-preview-card"><div className="preview-heading"><span>Browser preview</span><small>Local only · not uploaded</small></div><div className="image-preview-frame">{previewError ? <div className="preview-unavailable"><AlertTriangle size={18} /><span>This browser cannot preview this image format, but the file can still be processed.</span></div> : <img src={previewUrl} alt={`Preview of ${source.name}`} onError={() => setPreviewError(true)} />}</div></div>}<div className="limit-row"><span>Maximum file size</span><strong>{isImage ? "25 MB" : "2 GB"}</strong></div>{processingMode === "local" && <label className="keep-result-check"><input type="checkbox" checked={keepResult} onChange={(event) => setKeepResult(event.target.checked)} /><span>Keep final result on this device</span></label>}</section>
    {isImage ? <section className="tool-card settings-card"><div className="card-heading"><div><span className="card-index">02</span><h2>Choose output</h2></div><span className="optional-label">Optional target</span></div><p className="card-description">Original keeps the selected file type, so a PNG remains a PNG. A size target aims for the requested KB without changing pixel dimensions.</p><div className="format-grid">{imageFormats.map(([value, label, detail]) => <button type="button" key={value} className={`format-option ${format === value ? "selected" : ""}`} onClick={() => { setFormat(value); if (value !== "jpeg") setJpegConfirmed(false); }}><span className="format-radio" /><strong>{label}</strong><small>{detail}</small></button>)}</div><label className="field-label">Processing method <span>Worker engine</span></label><div className="method-list">{imageMethods.map(([value, label, detail, tag]) => { const unavailable = (value === "imagemagick" && capabilities?.status === "ready" && !imageMagickReady) || (value === "sips" && capabilities?.status === "ready" && !sipsReady); return <button type="button" key={value} className={`method-option ${method === value ? "selected" : ""} ${unavailable ? "unavailable" : ""}`} disabled={unavailable} onClick={() => setMethod(value)}><span className="method-copy"><strong>{label}</strong><small>{detail}</small></span><span className="method-tag">{unavailable ? "Unavailable" : tag}</span></button>; })}</div><label className="field-label" htmlFor="max-size">Target size <span>KB</span></label><div className="input-with-suffix"><input id="max-size" type="text" inputMode="numeric" value={maxSizeKb} onChange={(event) => setMaxSizeKb(event.target.value.replace(/[^0-9]/g, ""))} placeholder="Leave blank for normal quality" /><span>KB target</span></div>{format === "jpeg" && <label className="warning-check"><input type="checkbox" checked={jpegConfirmed} onChange={(event) => setJpegConfirmed(event.target.checked)} /><span><AlertTriangle size={16} /><span>JPEG flattens transparent pixels. I understand.</span></span></label>}</section> : <section className="tool-card settings-card"><div className="card-heading"><div><span className="card-index">02</span><h2>Reference video</h2></div><span className={serverReferenceReady ? "optional-label" : "required-label"}>{serverReferenceReady ? "Optional server fallback" : "Upload for damaged MP4"}</span></div><p className="card-description">A healthy recording from the same device or app can rebuild missing MP4 metadata when it was recorded with the same settings.</p><FileDropzone file={reference} onFile={setReference} onClear={() => setReference(null)} variant="video" accept="video/*,.mkv,.webm,.avi,.3gp" label="Drop a reference video" hint={serverReferenceReady ? "or continue without one" : "required when MP4 metadata is missing"} disabled={Boolean(uploadProgress)} /><div className="info-note"><Info size={16} /><span>{capabilities?.video?.untrunc ? (serverReferenceReady ? "Reference recovery is available. If you do not upload one, the configured server reference will be tried." : "No server-side reference is configured. Upload a healthy recording from the same device or app for missing MP4 metadata; readable containers can still be repaired without one.") : "FFmpeg can repair readable containers. Missing MP4 metadata requires Untrunc and a matching healthy reference."}</span></div></section>}
      <section className="tool-card action-card"><div className="action-copy"><div className="action-icon"><Zap size={19} /></div><div><h2>Ready when you are</h2><p>{isImage ? "Your output will be created as a new file." : "The worker will try the safest recovery method first."}</p></div></div><button className="primary-button" onClick={submit} disabled={!canSubmit}>{uploadProgress ? <><LoaderCircle className="spin" size={18} /> Uploading {uploadProgress}%</> : <><Sparkles size={18} /> {isImage ? "Convert image" : "Repair video"}</>}</button></section>
    </div>}
    {!job && !isImage && <VideoRecoverySummary hasServerReference={serverReferenceReady} hasUntrunc={capabilities?.video?.untrunc} />}
    {error && <div className="error-banner"><AlertTriangle size={18} /><span>{error}</span></div>}
    {!job && <div className="trust-row"><div><CheckCircle2 size={16} /> No resizing by default</div><div><Clock3 size={16} /> Temporary processing only</div><div><ShieldCheck size={16} /> Private worker pipeline</div></div>}
    </>}
  </AppShell>;
}

function VideoRecoverySummary({ hasServerReference, hasUntrunc }) {
  const capabilityText = hasUntrunc === undefined
    ? "Checking reference-video support."
    : hasUntrunc
      ? hasServerReference
        ? "A backup video is set up on the server if you do not upload one."
        : "No backup video is set up. Upload a healthy matching video when needed."
      : "The reference-repair tool is not installed, so missing MP4 information cannot be rebuilt."
    ;
  return <section className="recovery-summary" aria-label="Video repair reference summary">
    <div className="recovery-summary-heading">Recovery summary</div>
    <div className="recovery-table-wrap">
      <table className="recovery-table">
        <thead><tr><th>Video situation</th><th>Need another video?</th><th>What happens</th></tr></thead>
        <tbody>
          <tr><td>Video opens normally</td><td>No</td><td>Make a new copy and fix its timing and file information.</td></tr>
          <tr><td>MKV or WebM file</td><td>No</td><td>Rebuild the file when MKVToolNix is available, then make an MP4 copy.</td></tr>
          <tr><td>Some parts are damaged, but the file opens</td><td>No</td><td>Save the parts that can still be read. Bad parts may be skipped.</td></tr>
          <tr><td>MP4/MOV/M4V/3GP will not open because its file information is missing (<code>moov</code>)</td><td><strong>Yes</strong></td><td>Use a healthy video from the same device/app to rebuild the file.</td></tr>
          <tr><td>The actual picture data is broken</td><td>Cannot fix the picture</td><td>Blank, frozen, or distorted parts may remain.</td></tr>
        </tbody>
      </table>
    </div>
    <p className="recovery-summary-status">{capabilityText}</p>
  </section>;
}

function JobStatusCard({ job, isImage, mode, keepResult, onReset }) {
  const done = job.status === "completed";
  const failed = job.status === "failed";
  const bestEffort = done && (job.warnings || []).some((warning) => /damaged frames/i.test(warning));
  const progress = Math.max(0, Math.min(100, job.progress));
  return <section className={`job-card ${done ? "success" : failed ? "failed" : ""}`}>
    <div className="job-topline"><span className="job-status-pill">{done ? <CheckCircle2 size={15} /> : failed ? <AlertTriangle size={15} /> : <LoaderCircle className="spin" size={15} />}{done ? (bestEffort ? "Best effort" : "Complete") : failed ? "Needs attention" : job.status === "queued" ? "Queued" : "Processing"}</span><span className="job-id">Job {job.id.slice(0, 8)}</span></div>
    <div className="job-icon">{done ? <FileCheck2 size={30} /> : failed ? <AlertTriangle size={30} /> : <LoaderCircle className="spin" size={30} />}</div>
    <h2>{done ? (bestEffort ? "Best-effort result created" : "Your file is ready") : failed ? "We could not complete this job" : job.stage}</h2>
    <p className="job-message">{failed ? job.error : job.message}</p>
    {!done && !failed && <>
      <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
      <div className="progress-meta"><span>{job.stage}</span><strong>{progress}%</strong></div>
      {!isImage && <ConversionProgress conversion={job.conversion} />}
    </>}
    <JobLogPanel logs={job.logs || []} />
    {done && job.result && isImage && <ResultImagePreview result={job.result} />}
    {done && job.result && !isImage && <ResultVideoPreview result={job.result} />}
    {done && job.result && <div className="result-summary"><div><span>Output</span><strong>{job.result.filename}</strong></div><div><span>Size</span><strong>{formatBytes(job.result.bytes)}</strong></div>{isImage && job.result.targetSizeKb && <div><span>Size target</span><strong>{job.result.targetMet ? `Near ${job.result.targetSizeKb} KB` : "Not reached"}</strong></div>}{isImage && job.result.width && <div><span>Resolution</span><strong>{job.result.width} × {job.result.height}</strong></div>}<div><span>Method</span><strong>{job.result.method || "Completed"}</strong></div></div>}
    {job.warnings.length > 0 && <div className="warning-list">{job.warnings.map((warning) => <div key={warning}><AlertTriangle size={16} /><span>{warning}</span></div>)}</div>}
    {done && job.result && <ResultDownloadNote result={job.result} mode={mode} keepResult={keepResult} />}<div className="job-actions">{done && job.result && <a className="primary-button" href={job.result.downloadUrl} download={job.result.filename}><Download size={18} /> Download result</a>}<button className="secondary-button" onClick={onReset}><RotateCcw size={17} /> {done || failed ? "Process another file" : "Cancel"}</button></div>
  </section>;
}

function ConversionProgress({ conversion }) {
  if (!conversion || (!conversion.current && conversion.progress === null)) return null;
  const hasPercent = Number.isFinite(conversion.progress);
  const current = conversion.current || "00:00:00.0";
  const label = conversion.total
    ? `Video converted: ${current} of ${conversion.total}`
    : `Video converted: ${current}`;
  return <div className="conversion-progress" aria-label="Video conversion progress">
    <div className="conversion-progress-heading"><span>Video conversion</span><strong>{hasPercent ? `${conversion.progress}%` : "In progress"}</strong></div>
    <div className={`conversion-progress-track ${hasPercent ? "" : "indeterminate"}`}><span style={hasPercent ? { width: `${conversion.progress}%` } : undefined} /></div>
    <div className="conversion-progress-meta"><span>{label}</span><span>{hasPercent ? "Based on video time" : "Total length unavailable"}</span></div>
  </div>;
}

function ResultImagePreview({ result }) {
  const [previewError, setPreviewError] = useState(false);
  return <div className="result-image-preview"><div className="preview-heading"><span>Converted preview</span><small>Rendered from worker output</small></div><div className="result-preview-frame">{previewError ? <div className="preview-unavailable"><AlertTriangle size={18} /><span>This browser cannot preview {result.filename}, but the converted file is ready to download.</span></div> : <img src={result.previewUrl || `${result.downloadUrl}?preview=1`} alt={`Converted preview of ${result.filename}`} onError={() => setPreviewError(true)} />}</div></div>;
}

function ResultVideoPreview({ result }) {
  const [previewError, setPreviewError] = useState(false);
  const previewUrl = result.previewUrl || `${result.downloadUrl}?preview=1`;
  return <div className="result-video-preview"><div className="preview-heading"><span>Repaired preview</span><small>Check the video before downloading</small></div><div className="result-video-frame">{previewError ? <div className="preview-unavailable"><AlertTriangle size={18} /><span>This browser cannot play this MP4, but the repaired file is ready to download.</span></div> : <video controls preload="metadata" playsInline onError={() => setPreviewError(true)} aria-label={`Preview of ${result.filename}`}><source src={previewUrl} type="video/mp4" /></video>}</div></div>;
}

function formatLogTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function JobLogPanel({ logs }) {
  return <div className="job-log-panel"><div className="job-log-heading"><span><span className="log-live-dot" /> Worker log</span><span>{logs.length} events</span></div><div className="job-log-list" aria-live="polite">{logs.length ? logs.map((entry, index) => <div className={`job-log-entry ${entry.level === "error" ? "error" : ""}`} key={`${entry.time}-${index}`}><time>{formatLogTime(entry.time)}</time><span>{entry.message}</span></div>) : <div className="job-log-empty">Waiting for the worker to report progress…</div>}</div></div>;
}
