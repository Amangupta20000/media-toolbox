"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ClipboardPaste, Download, Info, LoaderCircle, Palette, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { FileDropzone, formatBytes } from "./file-dropzone.jsx";
import { JobStatusCard } from "./tool-page.jsx";
import { ProcessingMode } from "./processing-mode.jsx";
import { ToolHistory, ToolViewTabs } from "./tool-history.jsx";
import { ToolFaqContent, ToolSeoContent } from "./tool-seo-content.jsx";
import { ProcessingOptionsPanel } from "./processing-options.jsx";
import { processBrowserSvg } from "./browser-processing.js";
import { takeHistoryEdit } from "./history-edit.js";
import { isProcessingLocationReady, getProcessingJob, preferredProcessingMode, probeProcessingLocations, uploadWithProgress, deleteProcessingJob } from "./processing-client.js";
import { normalizeSvgOptions, validateSvgMarkup } from "../lib/svg-options.js";

const scaleOptions = [
  ["1", "1×", "Intrinsic size"],
  ["2", "2×", "Double resolution"],
  ["3", "3×", "Triple resolution"],
  ["4", "4×", "Four times resolution"],
  ["custom", "Custom", "Set exact dimensions"],
];

function svgFile(markup, name = "pasted-artwork.svg") {
  return new File([markup], name.toLowerCase().endsWith(".svg") ? name : `${name}.svg`, { type: "image/svg+xml" });
}

export function SvgToPngTool() {
  const [source, setSource] = useState(null);
  const [svgCode, setSvgCode] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [scale, setScale] = useState("1");
  const [customWidth, setCustomWidth] = useState("1024");
  const [customHeight, setCustomHeight] = useState("1024");
  const [background, setBackground] = useState("transparent");
  const [backgroundColor, setBackgroundColor] = useState("#ffffff");
  const [locations, setLocations] = useState(null);
  const [processingMode, setProcessingMode] = useState("local");
  const [jobMode, setJobMode] = useState("local");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState("");
  const [activeView, setActiveView] = useState("tool");
  const browserObjectUrlsRef = useRef(new Set());
  const browserRunRef = useRef(0);

  useEffect(() => {
    let active = true;
    probeProcessingLocations({ tool: "svg-to-png" }).then((value) => {
      if (!active) return;
      setLocations(value);
      setProcessingMode(preferredProcessingMode(value));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    for (const url of browserObjectUrlsRef.current) URL.revokeObjectURL(url);
    browserObjectUrlsRef.current.clear();
  }, []);

  useEffect(() => {
    if (!jobId || jobMode === "browser") return undefined;
    let active = true;
    let timer;
    const poll = async () => {
      try {
        const current = await getProcessingJob(jobMode, jobId);
        if (!active) return;
        setJob(current);
        if (current.status === "queued" || current.status === "processing") timer = window.setTimeout(poll, 900);
      } catch (pollError) {
        if (active) setError(pollError instanceof Error ? pollError.message : "Unable to read the conversion status.");
      }
    };
    poll();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [jobId, jobMode]);

  useEffect(() => {
    if (!source) {
      setPreviewUrl("");
      return undefined;
    }
    const url = URL.createObjectURL(source);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [source]);

  useEffect(() => {
    const pending = takeHistoryEdit("svg-to-png");
    if (!pending?.downloadUrl) return undefined;
    setError("SVG source files can be reopened from the original file or pasted code; PNG results are download-only.");
    return undefined;
  }, []);

  const busy = Boolean(job && ["queued", "processing"].includes(job.status)) || Boolean(uploadProgress);
  const processingReady = isProcessingLocationReady(locations, processingMode);

  const applyMarkup = (markup, filename = "pasted-artwork.svg") => {
    try {
      const validMarkup = validateSvgMarkup(markup);
      setSvgCode(validMarkup);
      setSource(svgFile(validMarkup, filename));
      setError("");
      return true;
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : "The SVG could not be read.");
      return false;
    }
  };

  const handleFile = async (file) => {
    if (!file) return;
    if (file.size > 25 * 1000 * 1000) {
      setError("SVG files must be 25 MB or smaller.");
      return;
    }
    try {
      applyMarkup(await file.text(), file.name || "artwork.svg");
    } catch {
      setError("The SVG file could not be read.");
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const value = await navigator.clipboard.readText();
      setSvgCode(value);
      applyMarkup(value);
    } catch {
      setError("Clipboard access was unavailable. Paste the SVG code into the box instead.");
    }
  };

  const updateDimension = (setter) => (event) => setter(event.target.value.replace(/[^0-9]/g, ""));

  const reset = () => {
    browserRunRef.current += 1;
    for (const url of browserObjectUrlsRef.current) URL.revokeObjectURL(url);
    browserObjectUrlsRef.current.clear();
    if (jobId && job && ["queued", "processing"].includes(job.status)) deleteProcessingJob(jobMode, jobId).catch(() => undefined);
    setSource(null);
    setSvgCode("");
    setScale("1");
    setCustomWidth("1024");
    setCustomHeight("1024");
    setBackground("transparent");
    setBackgroundColor("#ffffff");
    setUploadProgress(0);
    setJobMode("local");
    setJobId(null);
    setJob(null);
    setError("");
  };

  const submit = async () => {
    setError("");
    if (!source) {
      setError("Upload an SVG file or apply pasted SVG code first.");
      return;
    }
    if (!processingReady) {
      setError(processingMode === "server" ? "The server processing worker is not ready." : "Start and authorize the Local agent before converting an SVG.");
      return;
    }
    let svgOptions;
    try {
      svgOptions = normalizeSvgOptions({ scale, width: customWidth, height: customHeight, background, backgroundColor });
      validateSvgMarkup(svgCode);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : "Choose valid SVG conversion settings.");
      return;
    }
    if (processingMode === "browser") {
      const runId = ++browserRunRef.current;
      setJobMode("browser");
      setJobId(null);
      setJob({ id: `browser-${runId}`, status: "processing", progress: 1, stage: "Reading SVG", message: "The browser is preparing the SVG.", logs: [], warnings: [], error: null, result: null });
      try {
        const converted = await processBrowserSvg(source, svgOptions, {
          onProgress: (progress, message) => {
            if (browserRunRef.current === runId) setJob((current) => current ? { ...current, progress, stage: message || "Processing" } : current);
          },
        });
        if (browserRunRef.current !== runId) return;
        const downloadUrl = URL.createObjectURL(converted.blob);
        browserObjectUrlsRef.current.add(downloadUrl);
        setJob({ id: `browser-${runId}`, status: "completed", progress: 100, stage: "Complete", message: "The PNG is ready to download.", logs: [], warnings: converted.result.warnings || [], error: null, result: { ...converted.result, downloadUrl, previewUrl: downloadUrl } });
      } catch (browserError) {
        if (browserRunRef.current === runId) setJob({ id: `browser-${runId}`, status: "failed", progress: 100, stage: "Failed", message: "Browser conversion failed.", logs: [], warnings: [], error: browserError instanceof Error ? browserError.message : "The browser could not process this SVG.", result: null });
      }
      return;
    }
    const form = new FormData();
    form.append("tool", "svg-to-png");
    form.append("source", source, source.name);
    form.append("svgOptions", JSON.stringify(svgOptions));
    form.append("retention", "delete");
    try {
      setUploadProgress(1);
      const response = await uploadWithProgress(form, processingMode, setUploadProgress);
      setUploadProgress(0);
      setJobMode(processingMode);
      setJobId(response.jobId);
      setJob({ id: response.jobId, status: "queued", progress: 0, stage: "Queued", message: "Waiting for the local worker.", logs: [], warnings: [], error: null, result: null });
    } catch (submitError) {
      setUploadProgress(0);
      setError(submitError instanceof Error ? submitError.message : "The SVG upload failed.");
    }
  };

  return <AppShell>
    <div className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> Rasterize & export <span className="beta-label">Beta</span></div><h1>SVG to PNG converter</h1><p>Upload an SVG or paste its code, then export at 1×, 2×, 3×, 4×, or a custom size with a transparent or colour-picked background.</p></div><div className="heading-note"><ShieldCheck size={16} /><span>Local or browser processing</span></div></div>
    <ToolViewTabs value={activeView} onChange={setActiveView} />
    <ProcessingOptionsPanel tool="svg-to-png" locations={locations} value={processingMode} hidden={activeView !== "processing"} onSelect={(mode) => { setProcessingMode(mode); setActiveView("tool"); }} />
    {activeView === "history" ? <ToolHistory tool="svg-to-png" /> : activeView === "guide" ? <ToolSeoContent pathname="/svg-to-png" /> : activeView === "processing" ? null : <>
      <ProcessingMode value={processingMode} onChange={setProcessingMode} onChangeView={() => setActiveView("processing")} locations={locations} tool="svg-to-png" />
      <div className="capability-strip"><div className="capability-main"><span className={`capability-dot ${processingReady ? "ready" : ""}`} /><span>{processingReady ? `${processingMode === "browser" ? "Browser" : processingMode === "server" ? "Server worker" : "Local agent"} ready for SVG conversion` : processingMode === "browser" ? "Browser conversion unavailable" : processingMode === "server" ? "Server worker unavailable" : "Connect the Local agent to convert"}</span></div><span>SVG input · PNG output</span></div>
      {job ? <JobStatusCard job={job} isImage mode={jobMode} keepResult={false} onReset={reset} /> : <div className="workspace-grid svg-workspace-grid">
        <section className="tool-card primary-card svg-source-card"><div className="card-heading"><div><span className="card-index">01</span><h2>Add SVG source</h2></div><span className="required-label">Required</span></div><FileDropzone file={source} onFile={handleFile} onClear={() => { setSource(null); setSvgCode(""); setError(""); }} variant="image" accept=".svg,image/svg+xml" label="Drop an SVG file here" hint="or click to browse from your device" required disabled={busy} />
          <div className="svg-code-divider"><span>or paste SVG code</span><button type="button" className="text-button" onClick={pasteFromClipboard} disabled={busy}><ClipboardPaste size={14} /> Paste from clipboard</button></div>
          <textarea className="svg-code-input" value={svgCode} onChange={(event) => setSvgCode(event.target.value)} placeholder="<svg viewBox=&quot;0 0 800 600&quot; ...>" aria-label="Paste SVG code" disabled={busy} />
          <button type="button" className="secondary-button svg-apply-button" onClick={() => applyMarkup(svgCode)} disabled={busy || !svgCode.trim()}><Info size={15} /> Use pasted SVG</button>
          {source && previewUrl && <div className="svg-preview-card"><div className="preview-heading"><span>Source preview</span><small>{formatBytes(source.size)} · local only</small></div><div className="svg-preview-frame"><img src={previewUrl} alt="Preview of the selected SVG" /></div></div>}
          <div className="info-note"><Info size={16} /><span>Scripts, external resources, and active embedded content are blocked. The original SVG is never overwritten.</span></div>
        </section>
        <section className="tool-card settings-card svg-settings-card"><div className="card-heading"><div><span className="card-index">02</span><h2>Choose PNG output</h2></div><span className="optional-label">Beta</span></div><label className="field-label">Export size <span>PNG pixels</span></label><div className="svg-scale-grid" aria-label="SVG export scale">{scaleOptions.map(([value, label, detail]) => <button type="button" key={value} className={`format-option ${scale === value ? "selected" : ""}`} onClick={() => setScale(value)}><span className="format-radio" /><strong>{label}</strong><small>{detail}</small></button>)}</div>{scale === "custom" && <div className="svg-custom-size"><label className="field-label" htmlFor="svg-custom-width"><span>Width</span><strong>1–8192 px</strong></label><div className="input-with-suffix"><input id="svg-custom-width" type="number" min="1" max="8192" value={customWidth} onChange={updateDimension(setCustomWidth)} /><span>px</span></div><label className="field-label" htmlFor="svg-custom-height"><span>Height</span><strong>1–8192 px</strong></label><div className="input-with-suffix"><input id="svg-custom-height" type="number" min="1" max="8192" value={customHeight} onChange={updateDimension(setCustomHeight)} /><span>px</span></div></div>}
          <label className="field-label">Background <span>PNG canvas</span></label><div className="svg-background-options"><button type="button" className={`format-option ${background === "transparent" ? "selected" : ""}`} onClick={() => setBackground("transparent")}><span className="format-radio" /><strong>Transparent</strong><small>Preserve alpha</small></button><button type="button" className={`format-option ${background === "color" ? "selected" : ""}`} onClick={() => setBackground("color")}><Palette size={16} /><strong>Solid colour</strong><small>Choose a background</small></button></div>{background === "color" && <label className="svg-color-picker" htmlFor="svg-background-color"><span>Background colour</span><input id="svg-background-color" type="color" value={backgroundColor} onChange={(event) => setBackgroundColor(event.target.value)} /><code>{backgroundColor}</code></label>}
          <div className="svg-output-note"><CheckCircle2 size={16} /><span>{scale === "custom" ? `${customWidth || "—"} × ${customHeight || "—"} px output` : `${scale}× intrinsic SVG dimensions`} · PNG</span></div>
        </section>
        <section className="tool-card action-card"><div className="action-copy"><div className="action-icon"><Sparkles size={19} /></div><div><h2>Ready to rasterize?</h2><p>{processingMode === "browser" ? "This browser will create a new PNG without uploading the SVG." : processingMode === "server" ? "The server worker will create a new PNG." : "The Local agent will create a new PNG on this computer."}</p></div></div><button className="primary-button" type="button" onClick={submit} disabled={busy || !source || !processingReady}>{uploadProgress ? <><LoaderCircle className="spin" size={18} /> Uploading {uploadProgress}%</> : <><Download size={18} /> Convert to PNG</>}</button></section>
      </div>}
      {error && <div className="error-banner"><Info size={17} /><span>{error}</span></div>}
      {!job && <div className="trust-row"><div><CheckCircle2 size={16} /> Source stays untouched</div><div><ShieldCheck size={16} /> Local agent pipeline</div><div><Sparkles size={16} /> Transparent PNG support</div></div>}
      <ToolFaqContent pathname="/svg-to-png" />
    </>}
  </AppShell>;
}
