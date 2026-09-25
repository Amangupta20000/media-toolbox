"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock3, Download, FileArchive, FileCheck2, Info, LoaderCircle, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { FileDropzone, formatBytes } from "./file-dropzone.jsx";
import { ProcessingMode } from "./processing-mode.jsx";
import { ProcessingOptionsPanel } from "./processing-options.jsx";
import { ResultDownloadNote } from "./result-download-note.jsx";
import { downloadFilename, downloadUrlWithFilename, filenameStem, ResultFilenameField } from "./result-filename.jsx";
import { ToolFaqContent, ToolSeoContent } from "./tool-seo-content.jsx";
import { ToolHistory, ToolViewTabs } from "./tool-history.jsx";
import { DismissibleMessage } from "./dismissible-message.jsx";
import { deleteProcessingJob, getProcessingJob, isProcessingLocationReady, preferredProcessingMode, processingCapabilities, probeProcessingLocations, uploadWithProgress } from "./processing-client.js";
import { storedAdminToken } from "./license-client.js";
import { pushAnalyticsEvent } from "../lib/analytics.js";

const VIDEO_ACCEPT = "video/*,.mkv,.webm,.avi,.3gp,.mpeg,.mpg";
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const toolConfig = {
  "video-compressor": { eyebrow: "Reduce video size", title: "Private video compressor", description: "Create a smaller MP4 copy with practical quality presets. The Local agent processes the video on your computer and leaves the original untouched.", inputLabel: "Add a video to compress", dropLabel: "Drop a video here", limit: "2 GB", action: "Compress video" },
  "audio-extractor": { eyebrow: "Video to audio locally", title: "Video to audio converter", description: "Convert the first audio track from a video file as MP3, WAV, AAC, FLAC, or M4A. Your source remains untouched.", inputLabel: "Add a video", dropLabel: "Drop a video here", limit: "2 GB", action: "Extract audio" },
  "pdf-to-images": { eyebrow: "Render PDF pages", title: "Convert PDF to JPG or PNG images", description: "Render every PDF page as a numbered image and download the complete set in one ZIP archive. Processing stays with the Local agent.", inputLabel: "Add a PDF to render", dropLabel: "Drop a PDF here", limit: "200 MB · 300 pages", action: "Convert to images" },
};

const videoProfiles = [
  ["balanced", "Balanced", "A practical size and quality trade-off"],
  ["small", "Small file", "Stronger compression with a 1280 px width ceiling"],
  ["quality", "Higher quality", "Preserve more visual detail"],
];
const audioFormats = [
  ["mp3", "MP3", "Small and widely compatible"],
  ["wav", "WAV", "Lossless PCM audio"],
  ["aac", "AAC", "Efficient lossy audio"],
  ["flac", "FLAC", "Lossless compressed audio"],
  ["m4a", "M4A", "AAC in a shareable container"],
];
const audioBitrates = ["128k", "192k", "256k"];
const pdfFormats = [
  ["png", "PNG", "Lossless; best for text and diagrams"],
  ["jpg", "JPG", "Smaller files with adjustable quality"],
];
const pdfScales = [
  ["1", "1×", "Standard page resolution"],
  ["1.5", "1.5×", "More detail for sharing or review"],
  ["2", "2×", "Highest available detail"],
];

function activeJobStorageKey(tool) {
  return `media-toolbox-active-job:${tool}`;
}

function readActiveJob(tool) {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(activeJobStorageKey(tool)) || "null");
    if (!value || !/^[a-zA-Z0-9_-]{8,128}$/.test(String(value.id || "")) || !["local", "server"].includes(value.mode)) return null;
    return { id: String(value.id), mode: value.mode };
  } catch {
    return null;
  }
}

function rememberActiveJob(tool, id, mode) {
  if (typeof window === "undefined" || mode === "browser") return;
  window.localStorage.setItem(activeJobStorageKey(tool), JSON.stringify({ id, mode }));
}

function forgetActiveJob(tool) {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(activeJobStorageKey(tool));
}

function formatDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return String(minutes) + ":" + String(seconds).padStart(2, "0");
}

function LocalJobLog({ logs = [] }) {
  return <div className="job-log-panel"><div className="job-log-heading"><span><span className="log-live-dot" /> Worker log</span><span>{logs.length} events</span></div><div className="job-log-list" aria-live="polite">{logs.length ? logs.map((entry, index) => <div className={"job-log-entry " + (entry.level === "error" ? "error" : "")} key={String(entry.time) + "-" + index}><time>{new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time><span>{entry.message}</span></div>) : <div className="job-log-empty">Waiting for the worker to report progress…</div>}</div></div>;
}

function ConversionProgress({ conversion, mediaType = "Video" }) {
  if (!conversion || (!conversion.current && conversion.progress === null)) return null;
  const hasPercent = Number.isFinite(conversion.progress);
  const current = conversion.current || "00:00:00.0";
  const label = conversion.total
    ? `${mediaType} processed: ${current} of ${conversion.total}`
    : `${mediaType} processed: ${current}`;
  return <div className="conversion-progress" aria-label={`${mediaType} processing progress`}>
    <div className="conversion-progress-heading"><span>{mediaType} {mediaType === "Audio" ? "extraction" : "conversion"}</span><strong>{hasPercent ? `${conversion.progress}%` : "In progress"}</strong></div>
    <div className={`conversion-progress-track ${hasPercent ? "" : "indeterminate"}`}><span style={hasPercent ? { width: `${conversion.progress}%` } : undefined} /></div>
    <div className="conversion-progress-meta"><span>{label}</span><span>{hasPercent ? "Based on video time" : "Total length unavailable"}</span></div>
  </div>;
}

function LocalToolJobCard({ job, tool, mode, keepResult, onReset }) {
  const [filenameStemValue, setFilenameStemValue] = useState("");
  const done = job.status === "completed";
  const failed = job.status === "failed";
  const result = job.result;
  const filename = done && result ? downloadFilename(filenameStemValue || filenameStem(result.filename), result.filename) : "";
  const isVideo = tool === "video-compressor";
  const isAudio = tool === "audio-extractor";
  const isPdf = tool === "pdf-to-images";
  const resultType = isAudio ? "audio" : isPdf ? "archive" : "video";
  const previewUrl = result ? (result.previewUrl || result.downloadUrl + "?preview=1") : "";
  return <section className={"job-card " + (done ? "success" : failed ? "failed" : "")}>
    <div className="job-topline"><span className="job-status-pill">{done ? <CheckCircle2 size={15} /> : failed ? <AlertTriangle size={15} /> : <LoaderCircle className="spin" size={15} />}{done ? "Complete" : failed ? "Needs attention" : job.status === "queued" ? "Queued" : "Processing"}</span><span className="job-id">Job {String(job.id).slice(0, 8)}</span></div>
    <div className="job-icon">{done ? <FileCheck2 size={30} /> : failed ? <AlertTriangle size={30} /> : <LoaderCircle className="spin" size={30} />}</div>
    <h2>{done ? "Your file is ready" : failed ? "We could not complete this job" : job.stage}</h2>
    <p className="job-message">{failed ? job.error : job.message}</p>
    {!done && !failed && <><div className="progress-track"><span style={{ width: Math.max(0, Math.min(100, Number(job.progress) || 0)) + "%" }} /></div><div className="progress-meta"><span>{job.stage}</span><strong>{Math.max(0, Math.min(100, Number(job.progress) || 0))}%</strong></div>{(isVideo || isAudio) && <ConversionProgress conversion={job.conversion} mediaType={isAudio ? "Audio" : "Video"} />}</>}
    <LocalJobLog logs={job.logs || []} />
    {done && result && isVideo && <div className="result-video-preview"><div className="preview-heading"><span>Compressed preview</span><small>Review the new MP4 before downloading</small></div><div className="result-video-frame"><video controls preload="metadata" playsInline aria-label={"Preview of " + result.filename}><source src={previewUrl} type="video/mp4" /></video></div></div>}
    {done && result && isAudio && <div className="result-audio-preview"><div className="preview-heading"><span>Extracted audio preview</span><small>Review the audio before downloading</small></div><audio className="result-audio-player" controls preload="metadata" aria-label={"Preview of " + result.filename}><source src={previewUrl} /></audio></div>}
    {done && result && isPdf && <div className="result-archive-note"><FileArchive size={22} /><div><strong>ZIP archive ready</strong><span>Contains {result.pageCount} numbered {result.format === "jpg" ? "JPG" : "PNG"} page images at {result.scale}× scale.</span></div></div>}
    {done && result && <div className="result-summary"><div><span>Output</span><strong>{result.filename}</strong></div><div><span>Size</span><strong>{formatBytes(result.bytes)}</strong></div>{result.durationMs !== undefined && result.durationMs !== null && <div><span>Duration</span><strong>{formatDuration(result.durationMs)}</strong></div>}{result.pageCount && <div><span>Pages</span><strong>{result.pageCount}</strong></div>}{result.reductionPercent !== undefined && <div><span>Size change</span><strong>{result.reductionPercent > 0 ? "-" + result.reductionPercent + "%" : "No reduction"}</strong></div>}<div><span>Method</span><strong>{result.method || "Completed"}</strong></div></div>}
    {(job.warnings || []).map((warning) => <DismissibleMessage key={warning} className="error-banner" resetKey={warning}><AlertTriangle size={16} /><span>{warning}</span></DismissibleMessage>)}
    {done && result && <ResultDownloadNote result={result} mode={mode} keepResult={keepResult} filename={filename} />}
    {done && result && <ResultFilenameField originalFilename={result.filename} value={filenameStemValue || filenameStem(result.filename)} onChange={setFilenameStemValue} />}
    <div className="job-actions">{done && result && <a className="primary-button" href={downloadUrlWithFilename(result.downloadUrl, filename)} download={filename} onClick={() => pushAnalyticsEvent("result_downloaded", { tool, result_type: resultType })}><Download size={18} /> Download result</a>}<button className="secondary-button" type="button" onClick={onReset}><RotateCcw size={17} /> {done || failed ? "Process another file" : "Cancel"}</button></div>
  </section>;
}

export function LocalProcessingToolPage({ tool }) {
  const config = toolConfig[tool];
  const isPdf = tool === "pdf-to-images";
  const isVideo = tool === "video-compressor";
  const isAudio = tool === "audio-extractor";
  const [source, setSource] = useState(null);
  const [videoProfile, setVideoProfile] = useState("balanced");
  const [audioFormat, setAudioFormat] = useState("mp3");
  const [audioBitrate, setAudioBitrate] = useState("192k");
  const [audioInputMode, setAudioInputMode] = useState("file");
  const [audioUrl, setAudioUrl] = useState("");
  const [audioUrlConsent, setAudioUrlConsent] = useState(false);
  const [adminUrlAccess, setAdminUrlAccess] = useState(false);
  const [pdfFormat, setPdfFormat] = useState("png");
  const [pdfScale, setPdfScale] = useState("1.5");
  const [pdfQuality, setPdfQuality] = useState(90);
  const [locations, setLocations] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [processingMode, setProcessingMode] = useState("local");
  const [activeView, setActiveView] = useState("tool");
  const [keepResult, setKeepResult] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [jobId, setJobId] = useState("");
  const [jobMode, setJobMode] = useState("local");
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const trackedJobStatesRef = useRef(new Set());

  useEffect(() => {
    let active = true;
    probeProcessingLocations({ tool }).then((value) => {
      if (!active) return;
      setLocations(value);
      if (isAudio) setAdminUrlAccess(value.local?.authorization?.mode === "admin" || value.local?.health?.authorization?.mode === "admin" || Boolean(storedAdminToken()));
      const preferred = preferredProcessingMode(value);
      setProcessingMode(preferred || "local");
      setCapabilities(processingCapabilities(value, preferred || "local"));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [tool]);

  useEffect(() => {
    if (!isAudio || typeof window === "undefined") return undefined;
    const refreshAdminAccess = () => setAdminUrlAccess(locations?.local?.authorization?.mode === "admin" || locations?.local?.health?.authorization?.mode === "admin" || Boolean(storedAdminToken()));
    refreshAdminAccess();
    window.addEventListener("media-toolbox-admin-auth", refreshAdminAccess);
    const timer = window.setInterval(refreshAdminAccess, 3000);
    return () => { window.removeEventListener("media-toolbox-admin-auth", refreshAdminAccess); window.clearInterval(timer); };
  }, [isAudio, locations]);

  useEffect(() => {
    if (isAudio && !adminUrlAccess && audioInputMode === "url") {
      setAudioInputMode("file");
      setAudioUrl("");
      setAudioUrlConsent(false);
    }
  }, [adminUrlAccess, audioInputMode, isAudio]);

  useEffect(() => setCapabilities(processingCapabilities(locations, processingMode)), [locations, processingMode]);

  useEffect(() => {
    const saved = readActiveJob(tool);
    if (!saved) return;
    setJobMode(saved.mode);
    setProcessingMode(saved.mode);
    setJobId(saved.id);
    setJob({ id: saved.id, status: "queued", progress: 0, stage: "Reconnecting to job", message: "Restoring the job after this page was reloaded.", logs: [], warnings: [], error: null, result: null });
  }, [tool]);

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
        if (!active) return;
        if (pollError?.status === 404) {
          forgetActiveJob(tool);
          setJobId("");
          setJob(null);
          setError("This processing job is no longer available. You can submit the file again.");
        } else {
          setError(pollError instanceof Error ? pollError.message : "Unable to read job status.");
        }
      }
    };
    poll();
    return () => { active = false; };
  }, [jobId, jobMode, tool]);

  useEffect(() => {
    if (!job || !["completed", "failed"].includes(job.status)) return;
    const key = tool + ":" + job.id + ":" + job.status;
    if (trackedJobStatesRef.current.has(key)) return;
    trackedJobStatesRef.current.add(key);
    pushAnalyticsEvent(job.status === "completed" ? "processing_completed" : "processing_failed", job.status === "completed" ? { tool, mode: jobMode, result_type: tool === "pdf-to-images" ? "archive" : tool === "audio-extractor" ? "audio" : "video" } : { tool, mode: jobMode, error_category: "worker_failure" });
  }, [job, jobMode, tool]);

  const busy = Boolean(job && ["queued", "processing"].includes(job.status));
  const localVideoCompressorUnavailable = isVideo
    && processingMode === "local"
    && locations?.local?.connected
    && capabilities?.video?.compressor !== true;
  const ready = isProcessingLocationReady(locations, processingMode) && !localVideoCompressorUnavailable;
  const usingAudioUrl = isAudio && adminUrlAccess && audioInputMode === "url";
  const hasInput = usingAudioUrl ? Boolean(audioUrl.trim()) && audioUrlConsent : Boolean(source);
  const selectFile = (file) => {
    if (!file) return;
    const limit = isPdf ? MAX_PDF_BYTES : MAX_VIDEO_BYTES;
    if (file.size > limit) {
      setError(isPdf ? "This PDF is larger than 200 MB. Use a smaller document." : "This video is larger than 2 GB. Choose a smaller file.");
      return;
    }
    if (isAudio) setAudioInputMode("file");
    setSource(file);
    setError("");
    pushAnalyticsEvent("input_selected", { tool, input_type: isPdf ? "pdf" : "video", count: 1 });
  };

  const reset = () => {
    if (jobId && job && ["queued", "processing"].includes(job.status)) deleteProcessingJob(jobMode, jobId).catch(() => undefined);
    forgetActiveJob(tool);
    setSource(null);
    setAudioInputMode("file");
    setAudioUrl("");
    setAudioUrlConsent(false);
    setJobId("");
    setJob(null);
    setUploadProgress(0);
    setError("");
    setKeepResult(false);
  };

  const submit = async () => {
    if (!hasInput) {
      setError(usingAudioUrl
        ? audioUrl.trim() ? "Confirm that you own this content or have permission to download it." : "Enter a media URL first."
        : "Choose a " + (isPdf ? "PDF" : "video") + " first.");
      return;
    }
    if (!ready) {
      setError(localVideoCompressorUnavailable
        ? "Update the NativeMedia Agent before using Video Compressor. This installed agent does not support video compression yet."
        : "Start and authorize the Local agent before processing this file.");
      return;
    }
    const form = new FormData();
    form.append("tool", tool);
    if (usingAudioUrl) form.append("sourceUrl", audioUrl.trim());
    else form.append("source", source, source.name);
    if (isVideo) form.append("compressionProfile", videoProfile);
    else if (tool === "audio-extractor") {
      form.append("audioFormat", audioFormat);
      form.append("audioBitrate", audioBitrate);
    } else {
      form.append("pdfFormat", pdfFormat);
      form.append("pdfScale", pdfScale);
      form.append("pdfQuality", String(pdfQuality));
    }
    if (processingMode === "local") {
      form.append("retention", keepResult ? "keep" : "delete");
      form.append("historyStatus", "completed");
    }
    setError("");
    pushAnalyticsEvent("processing_started", { tool, mode: processingMode });
    try {
      setUploadProgress(1);
      const response = await uploadWithProgress(form, processingMode, setUploadProgress, { adminToken: usingAudioUrl ? storedAdminToken() : "" });
      const id = response.jobId || response.jobIds?.[0];
      if (!id) throw new Error("The processing job was not created.");
      setUploadProgress(0);
      setJobMode(processingMode);
      setJobId(id);
      rememberActiveJob(tool, id, processingMode);
      setJob({ id, status: "queued", progress: 0, stage: "Queued", message: "Waiting for the worker.", logs: [], warnings: [], error: null, result: null });
    } catch (submitError) {
      setUploadProgress(0);
      setError(submitError instanceof Error ? submitError.message : "The upload failed.");
    }
  };

  const outputControls = isVideo
    ? <section className="tool-card settings-card"><div className="card-heading"><div><span className="card-index">02</span><h2>Choose compression</h2></div><span className="optional-label">Video profile</span></div><p className="card-description">Every option creates a new MP4. Exact output size depends on the video’s resolution, motion, and detail.</p><div className="format-grid">{videoProfiles.map(([value, label, detail]) => <button type="button" key={value} className={"format-option " + (videoProfile === value ? "selected" : "")} onClick={() => setVideoProfile(value)}><span className="format-radio" /><strong>{label}</strong><small>{detail}</small></button>)}</div><div className="info-note"><Info size={16} /><span>Balanced is the recommended starting point. Use Small file when sharing limits matter more than detail.</span></div></section>
    : tool === "audio-extractor"
      ? <section className="tool-card settings-card"><div className="card-heading"><div><span className="card-index">02</span><h2>Choose audio output</h2></div><span className="optional-label">First audio track</span></div><p className="card-description">Choose a lossless or shareable format. Bitrate applies to MP3, AAC, and M4A.</p><div className="format-grid">{audioFormats.map(([value, label, detail]) => <button type="button" key={value} className={"format-option " + (audioFormat === value ? "selected" : "")} onClick={() => setAudioFormat(value)}><span className="format-radio" /><strong>{label}</strong><small>{detail}</small></button>)}</div>{["mp3", "aac", "m4a"].includes(audioFormat) && <><label className="field-label" htmlFor="audio-bitrate">Bitrate <span>Lossy audio quality</span></label><select id="audio-bitrate" className="select-input" value={audioBitrate} onChange={(event) => setAudioBitrate(event.target.value)}>{audioBitrates.map((value) => <option key={value} value={value}>{value}</option>)}</select></>}<div className="info-note"><Info size={16} /><span>Only the first audio track is extracted. The source video remains available after the job.</span></div></section>
      : <section className="tool-card settings-card"><div className="card-heading"><div><span className="card-index">02</span><h2>Choose image output</h2></div><span className="optional-label">One ZIP archive</span></div><p className="card-description">Render every page at a selected scale and download the numbered images together.</p><div className="format-grid">{pdfFormats.map(([value, label, detail]) => <button type="button" key={value} className={"format-option " + (pdfFormat === value ? "selected" : "")} onClick={() => setPdfFormat(value)}><span className="format-radio" /><strong>{label}</strong><small>{detail}</small></button>)}</div><label className="field-label" htmlFor="pdf-image-scale">Output scale <span>Higher scale creates more pixels</span></label><select id="pdf-image-scale" className="select-input" value={pdfScale} onChange={(event) => setPdfScale(event.target.value)}>{pdfScales.map(([value, label, detail]) => <option key={value} value={value}>{label} · {detail}</option>)}</select>{pdfFormat === "jpg" && <><label className="field-label" htmlFor="pdf-image-quality">JPG quality <span>{pdfQuality}</span></label><input id="pdf-image-quality" className="pdf-quality-range" type="range" min="50" max="100" step="1" value={pdfQuality} onChange={(event) => setPdfQuality(Number(event.target.value))} /></>}<div className="info-note"><Info size={16} /><span>PDF to images supports up to 300 pages. Password-protected PDFs must be unlocked first.</span></div></section>;

  return <AppShell>
    <div className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> {config.eyebrow}</div><h1>{config.title}</h1><p>{config.description}</p></div><div className="heading-note"><ShieldCheck size={16} /><span>Original files stay untouched</span></div></div>
    <ToolViewTabs value={activeView} onChange={setActiveView} />
    <ProcessingOptionsPanel tool={tool} locations={locations} value={processingMode} hidden={activeView !== "processing"} onSelect={(mode) => { setProcessingMode(mode); setActiveView("tool"); }} />
    {activeView === "history" ? <ToolHistory tool={tool} /> : activeView === "processing" ? null : <>
      <ProcessingMode value={processingMode} onChange={setProcessingMode} onChangeView={() => setActiveView("processing")} locations={locations} tool={tool} />
      <div className="tool-quick-start video-quick-start"><div className="tool-quick-start-heading"><span className="section-kicker"><span className="kicker-line" /> Before you start</span><strong>{isPdf ? "PDF rendering runs on the Local agent" : isVideo ? "Video compression runs on the Local agent" : "Audio extraction runs on the Local agent"}</strong></div><p className="tool-quick-start-intro">These tools use native desktop processing for larger media and predictable output. Start and authorize the Local agent before submitting.</p><div className="tool-quick-start-note"><Info size={16} /><span><strong>Input limit:</strong> {config.limit}. <Link href="/how-to-setup-agent">View the setup guide</Link> if the agent is not connected.</span></div></div>
      <div className="capability-strip"><div className="capability-main"><span className={"capability-dot " + (capabilities?.status === "ready" ? "ready" : "")} /><span>{capabilities?.status === "ready" ? "Local agent worker online" : "Connecting to Local agent"}</span></div><span>{isPdf ? capabilities?.pdf?.toImages !== false ? "PDF rendering ready" : "PDF capability checking" : isVideo ? capabilities?.video?.compressor === true ? "Video compression ready" : capabilities?.video ? "Update Local agent to enable compression" : "FFmpeg capability checking" : isAudio ? capabilities?.video?.audioExtractor ? "Audio extraction ready" : "FFmpeg capability checking" : capabilities?.video?.ffmpeg ? "FFmpeg processing ready" : "FFmpeg capability checking"}</span></div>
      {job ? <LocalToolJobCard job={job} tool={tool} mode={jobMode} keepResult={keepResult} onReset={reset} /> : <div className="workspace-grid">
        <section className="tool-card primary-card"><div className="card-heading"><div><span className="card-index">01</span><h2>{config.inputLabel}</h2></div><span className="required-label">Required</span></div>{isAudio && <div className="input-mode-toggle" role="tablist" aria-label="Audio source type"><button type="button" role="tab" aria-selected={!usingAudioUrl} className={!usingAudioUrl ? "selected" : ""} onClick={() => { setAudioInputMode("file"); setError(""); }} disabled={Boolean(uploadProgress || busy)}>Upload a file</button>{adminUrlAccess && <button type="button" role="tab" aria-selected={usingAudioUrl} className={usingAudioUrl ? "selected" : ""} onClick={() => { setAudioInputMode("url"); setSource(null); setError(""); }}>Use a media URL</button>}</div>}{usingAudioUrl ? <div className="url-input-panel"><label className="field-label" htmlFor="audio-source-url">Admin media URL <span>Internal testing only</span></label><input id="audio-source-url" className="url-input" type="url" inputMode="url" autoComplete="url" placeholder="https://example.com/video" value={audioUrl} onChange={(event) => { setAudioUrl(event.target.value); setError(""); }} disabled={Boolean(uploadProgress || busy)} /><label className="consent-checkbox"><input type="checkbox" checked={audioUrlConsent} onChange={(event) => setAudioUrlConsent(event.target.checked)} disabled={Boolean(uploadProgress || busy)} /><span>I own this content or have permission to download and convert it.</span></label><div className="info-note"><Info size={16} /><span>This internal URL workflow is available only to an authenticated Admin session.</span></div></div> : <FileDropzone file={source} onFile={selectFile} onClear={() => setSource(null)} variant={isPdf ? "pdf" : "video"} accept={isPdf ? ".pdf,application/pdf" : VIDEO_ACCEPT} label={config.dropLabel} hint="or click to browse from your device" required disabled={Boolean(uploadProgress || busy)} />}<div className="limit-row"><span>Maximum input</span><strong>{config.limit}</strong></div><div className="keep-result-slot visible"><label className="keep-result-check"><input type="checkbox" checked={keepResult} onChange={(event) => setKeepResult(event.target.checked)} /><span>Keep final result on this device</span></label></div></section>
        {outputControls}
        <section className="tool-card action-card"><div className="action-copy"><div className="action-icon"><Sparkles size={19} /></div><div><h2>Ready when you are</h2><p>A new result will be created and your original file will stay untouched.</p></div></div><button className="primary-button" type="button" onClick={submit} disabled={!hasInput || busy || Boolean(uploadProgress) || !ready} data-analytics-cta={tool} data-analytics-surface={tool}>{uploadProgress ? <><LoaderCircle className="spin" size={18} /> Uploading {uploadProgress}%</> : <><Sparkles size={18} /> {config.action}</>}</button></section>
      </div>}
      {error && <DismissibleMessage className="error-banner" resetKey={error}><AlertTriangle size={18} /><span>{error}</span></DismissibleMessage>}
      {!job && <div className="trust-row"><div><CheckCircle2 size={16} /> Original stays untouched</div><div><Clock3 size={16} /> Review before download</div><div><ShieldCheck size={16} /> Native local pipeline</div></div>}
      <ToolSeoContent pathname={"/" + tool} />
      <ToolFaqContent pathname={"/" + tool} />
    </>}
  </AppShell>;
}
