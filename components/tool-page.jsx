"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Download, FileCheck2, Info, LoaderCircle, RotateCcw, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { FileDropzone, formatBytes } from "./file-dropzone.jsx";
import { clipboardImageFile, isSupportedImageFile } from "../lib/image-input.js";
import { takeHistoryEdit } from "./history-edit.js";
import { ProcessingMode } from "./processing-mode.jsx";
import { ResultDownloadNote } from "./result-download-note.jsx";
import { downloadFilename, downloadUrlWithFilename, filenameStem, ResultFilenameField } from "./result-filename.jsx";
import { ToolHistory, ToolViewTabs } from "./tool-history.jsx";
import { DismissibleMessage } from "./dismissible-message.jsx";
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
const maxImageFiles = 5;

const imageMethods = [
  ["auto", "Auto", "Use the best available worker path", "recommended"],
  ["imagemagick", "ImageMagick", "Portable Linux conversion + libheif", "linux"],
  ["sips", "macOS sips", "Local Mac fallback", "macOS"],
];

const pdfCompressionProfiles = [
  ["balanced", "Balanced", "Good size reduction for everyday sharing", "ebook"],
  ["small", "Smallest file", "More image compression for email and web", "screen"],
  ["quality", "Higher quality", "Preserve more image detail while optimizing", "prepress"],
  ["custom", "Custom", "Choose image quality and color settings", "custom"],
];

function compressionQualityLabel(value) {
  const quality = Number(value) || 0;
  if (quality < 40) return "Low";
  if (quality < 60) return "Medium";
  if (quality < 80) return "High";
  return "Very high";
}

function estimatePdfCompression(source, profile, customQuality, removeColor, customTargetMb) {
  if (!source?.size) return null;
  const targetMb = Number(customTargetMb);
  if (profile === "custom" && Number.isFinite(targetMb) && targetMb > 0) {
    const originalBytes = Number(source.size);
    const estimatedBytes = Math.max(1000, Math.round(targetMb * 1000 * 1000));
    return { originalBytes, estimatedBytes, reductionPercent: Math.max(0, Math.round((1 - estimatedBytes / originalBytes) * 100)), target: true };
  }
  // This is only the instant fallback while the sampled estimate is being
  // calculated. The ratios mirror the bundled worker's current visual pass,
  // rather than promising the much smaller output of a different service.
  let estimatedRatio = { balanced: 0.69, small: 0.46, quality: 0.80 }[profile] || 0.69;
  if (profile === "custom") {
    const quality = Math.max(25, Math.min(90, Number(customQuality) || 72));
    estimatedRatio = 0.28 + ((quality - 25) / 65) * 0.50;
  }
  if (profile === "custom" && removeColor) estimatedRatio *= 0.86;
  const originalBytes = Number(source.size);
  const estimatedBytes = Math.max(1000, Math.round(originalBytes * estimatedRatio));
  return { originalBytes, estimatedBytes, reductionPercent: Math.max(0, Math.round((1 - estimatedBytes / originalBytes) * 100)) };
}

let pdfEstimateLibraryPromise;

async function loadPdfEstimateLibrary() {
  if (!pdfEstimateLibraryPromise) {
    pdfEstimateLibraryPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((library) => {
      if (library.GlobalWorkerOptions) library.GlobalWorkerOptions.workerSrc = "/api/pdf/worker";
      return library;
    });
  }
  return pdfEstimateLibraryPromise;
}

function estimateCompressionSettings(profile, customQuality) {
  if (profile === "small") return { quality: 58, maxImageDimension: 1600, rasterDpi: 72 };
  if (profile === "quality") return { quality: 84, maxImageDimension: 3000, rasterDpi: 120 };
  if (profile === "custom") {
    const quality = Math.max(25, Math.min(90, Number(customQuality) || 72));
    const qualityProgress = (quality - 25) / 65;
    return { quality, maxImageDimension: Math.round(1200 + qualityProgress * 1800), rasterDpi: Math.round(72 + qualityProgress * 48) };
  }
  return { quality: 72, maxImageDimension: 2200, rasterDpi: 96 };
}

function pdfImageInfo(operatorList, OPS) {
  const imageOperations = new Set([
    "paintImageXObject",
    "paintInlineImageXObject",
    "paintImageXObjectRepeat",
    "paintInlineImageXObjectGroup",
    "paintImageMaskXObject",
    "paintImageMaskXObjectGroup",
    "paintImageMaskXObjectRepeat",
  ].map((name) => OPS?.[name]).filter((value) => Number.isFinite(value)));
  let count = 0;
  let totalPixels = 0;
  let largestPixels = 0;
  for (const [index, operation] of operatorList.fnArray.entries()) {
    if (!imageOperations.has(operation)) continue;
    const args = operatorList.argsArray[index] || [];
    const imageData = Array.isArray(args[0]) ? args[0][0] : args[0];
    const width = Number(args[1] || imageData?.width || 0);
    const height = Number(args[2] || imageData?.height || 0);
    const pixels = width > 0 && height > 0 ? width * height : 0;
    count += 1;
    totalPixels += pixels;
    largestPixels = Math.max(largestPixels, pixels);
  }
  return { count, totalPixels, largestPixels };
}

function isImageHeavyPdfPage(info) {
  return info.count > 0 && (info.largestPixels >= 500_000 || info.totalPixels >= 1_000_000);
}

function jpegDataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",", 2)[1] || "";
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(base64.length * 0.75) - padding);
}

async function samplePdfPageJpegBytes(page, settings, removeColor) {
  const scale = settings.rasterDpi / 72;
  const viewport = page.getViewport({ scale, rotation: page.rotate || 0 });
  const rendered = document.createElement("canvas");
  rendered.width = Math.max(1, Math.ceil(viewport.width));
  rendered.height = Math.max(1, Math.ceil(viewport.height));
  const context = rendered.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, rendered.width, rendered.height);
  await page.render({ canvasContext: context, viewport }).promise;
  const maxDimension = Math.max(rendered.width, rendered.height);
  const target = maxDimension <= settings.maxImageDimension ? rendered : document.createElement("canvas");
  if (target !== rendered) {
    const ratio = settings.maxImageDimension / maxDimension;
    target.width = Math.max(1, Math.round(rendered.width * ratio));
    target.height = Math.max(1, Math.round(rendered.height * ratio));
    const targetContext = target.getContext("2d", { alpha: false });
    targetContext.fillStyle = "#ffffff";
    targetContext.fillRect(0, 0, target.width, target.height);
    if (removeColor) targetContext.filter = "grayscale(1)";
    targetContext.drawImage(rendered, 0, 0, target.width, target.height);
  } else if (removeColor) {
    const grayscale = document.createElement("canvas");
    grayscale.width = rendered.width;
    grayscale.height = rendered.height;
    const grayscaleContext = grayscale.getContext("2d", { alpha: false });
    grayscaleContext.filter = "grayscale(1)";
    grayscaleContext.drawImage(rendered, 0, 0);
    rendered.width = grayscale.width;
    rendered.height = grayscale.height;
    rendered.getContext("2d", { alpha: false }).drawImage(grayscale, 0, 0);
  }
  const bytes = jpegDataUrlBytes(target.toDataURL("image/jpeg", Math.max(0.48, (settings.quality - 4) / 100)));
  rendered.width = 0;
  if (target !== rendered) target.width = 0;
  return bytes;
}

async function calculatePdfCompressionEstimate(source, profile, customQuality, removeColor, customTargetMb) {
  const fallback = estimatePdfCompression(source, profile, customQuality, removeColor, customTargetMb);
  if (fallback?.target) return fallback;
  const library = await loadPdfEstimateLibrary();
  const bytes = new Uint8Array(await source.arrayBuffer());
  const sourceByteLength = bytes.byteLength;
  const pdf = await library.getDocument({ data: bytes }).promise;
  try {
    const heavyPages = [];
    const pageCount = pdf.numPages;
    for (let index = 1; index <= pageCount; index += 1) {
      const page = await pdf.getPage(index);
      const info = pdfImageInfo(await page.getOperatorList(), library.OPS);
      if (isImageHeavyPdfPage(info)) heavyPages.push(index);
      page.cleanup?.();
    }
    if (!heavyPages.length) return { ...fallback, pageCount, heavyPages: 0, sampledPages: 0, sampled: false };
    const settings = estimateCompressionSettings(profile, customQuality);
    const sampleIndexes = [...new Set(Array.from({ length: 8 }, (_, index) => Math.round((index * (heavyPages.length - 1)) / 7)))]
      .map((index) => heavyPages[index])
      .filter(Boolean);
    const sampledBytes = [];
    for (const pageNumber of sampleIndexes) {
      const page = await pdf.getPage(pageNumber);
      sampledBytes.push(await samplePdfPageJpegBytes(page, settings, profile === "custom" && removeColor));
      page.cleanup?.();
    }
    const averagePageBytes = sampledBytes.reduce((total, value) => total + value, 0) / Math.max(1, sampledBytes.length);
    const heavyFraction = heavyPages.length / pageCount;
    const rasterizedBytes = averagePageBytes * heavyPages.length;
    const preservedBytes = sourceByteLength * (1 - heavyFraction) * 0.78;
    const pdfOverheadBytes = pageCount * 2800;
    const sampledEstimate = Math.max(1000, Math.round(rasterizedBytes + preservedBytes + pdfOverheadBytes));
    const structuralRatio = { balanced: 0.94, small: 0.90, quality: 0.97, custom: 0.92 }[profile] || 0.94;
    const estimatedBytes = Math.min(sampledEstimate, Math.round(sourceByteLength * structuralRatio));
    return {
      originalBytes: sourceByteLength,
      estimatedBytes,
      reductionPercent: Math.max(0, Math.round((1 - estimatedBytes / sourceByteLength) * 100)),
      pageCount,
      heavyPages: heavyPages.length,
      sampledPages: sampledBytes.length,
      sampled: true,
    };
  } finally {
    await pdf.cleanup?.();
    await pdf.destroy?.();
  }
}

export function ToolPage({ tool }) {
  const isImage = tool === "image-converter";
  const isPdfCompressor = tool === "pdf-compressor";
  const [source, setSource] = useState(null);
  const [imageFiles, setImageFiles] = useState([]);
  const [imageSettings, setImageSettings] = useState([]);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [sameConversion, setSameConversion] = useState(false);
  const [sameSize, setSameSize] = useState(false);
  const [reference, setReference] = useState(null);
  const [method, setMethod] = useState("auto");
  const [compressionProfile, setCompressionProfile] = useState("balanced");
  const [customQuality, setCustomQuality] = useState(72);
  const [removeColor, setRemoveColor] = useState(false);
  const [customTargetMb, setCustomTargetMb] = useState("");
  const [compressionEstimate, setCompressionEstimate] = useState({ status: "idle", data: null });
  const [uploadProgress, setUploadProgress] = useState(0);
  const [jobId, setJobId] = useState(null);
  const [jobMode, setJobMode] = useState("server");
  const [job, setJob] = useState(null);
  const [batchJobs, setBatchJobs] = useState(null);
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
      // An authorized local agent may have no browser session yet. `ready`
      // means the agent has confirmed this origin and uploadWithProgress can
      // create the short-lived session when the user submits the job. This
      // keeps the trial from starting during a passive health probe while
      // avoiding a dead-end where Local is never selectable in a new browser.
      const preferred = value.server.connected ? "server" : value.local.connected || value.local.ready ? "local" : "server";
      setProcessingMode(preferred);
      setCapabilities(processingCapabilities(value, preferred));
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => setCapabilities(processingCapabilities(locations, processingMode)), [locations, processingMode]);

  useEffect(() => {
    setPreviewError(false);
    const previewSource = isImage ? imageFiles[0] : null;
    if (!previewSource) {
      setPreviewUrl("");
      return undefined;
    }
    const objectUrl = URL.createObjectURL(previewSource);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [isImage, imageFiles]);

  useEffect(() => {
    if (!isPdfCompressor || !source) {
      setCompressionEstimate({ status: "idle", data: null });
      return undefined;
    }
    let active = true;
    const fallback = estimatePdfCompression(source, compressionProfile, customQuality, removeColor, customTargetMb);
    // Do not show the quick ratio while the PDF is being sampled. That value
    // can describe a different worker path than the page-aware estimate and
    // causes a visible 32 MB -> 21 MB jump for image-heavy documents.
    setCompressionEstimate({ status: "loading", data: fallback?.target ? fallback : null });
    calculatePdfCompressionEstimate(source, compressionProfile, customQuality, removeColor, customTargetMb).then((data) => {
      if (active) setCompressionEstimate({ status: "ready", data });
    }).catch(() => {
      if (active) setCompressionEstimate({ status: "fallback", data: fallback });
    });
    return () => { active = false; };
  }, [isPdfCompressor, source, compressionProfile, customQuality, removeColor, customTargetMb]);

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

  useEffect(() => {
    if (!batchJobs?.length) return undefined;
    let active = true;
    let timer;
    const poll = async () => {
      const updated = await Promise.all(batchJobs.map(async (entry) => {
        if (["completed", "failed", "cancelled"].includes(entry.status)) return entry;
        try {
          return await getProcessingJob(jobMode, entry.id);
        } catch (pollError) {
          return { ...entry, status: "failed", error: pollError instanceof Error ? pollError.message : "Unable to read job status." };
        }
      }));
      if (!active) return;
      const changed = updated.some((entry, index) => entry !== batchJobs[index]);
      if (changed) setBatchJobs(updated);
      if (updated.some((entry) => entry.status === "queued" || entry.status === "processing")) timer = window.setTimeout(poll, 1000);
    };
    poll();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [batchJobs, jobMode]);

  const batchBusy = Boolean(batchJobs?.some((entry) => entry.status === "queued" || entry.status === "processing"));
  const busy = Boolean(jobId && job && (job.status === "queued" || job.status === "processing")) || batchBusy;
  const canSubmit = Boolean(isImage ? imageFiles.length : source) && !busy && !uploadProgress;
  const title = isImage ? "Image conversion" : isPdfCompressor ? "PDF compression" : "Video repair";
  const eyebrow = isImage ? "Format & size" : isPdfCompressor ? "Optimize & shrink" : "Recovery & salvage";
  const description = isImage ? "Convert image data between formats while keeping the original pixel dimensions intact." : isPdfCompressor ? "Reduce a PDF’s file size while keeping its pages readable and leaving the original untouched." : "Give damaged or unsupported footage a layered recovery pass without touching the original.";
  const heicReady = capabilities?.image?.heic || capabilities?.image?.sips;
  const imageMagickReady = capabilities?.image?.imagemagick !== false;
  const sipsReady = capabilities?.image?.sips === true;
  const serverReferenceReady = capabilities?.video?.defaultReference === true;
  const pdfCompressorReady = capabilities?.pdf?.compressor !== false;

  const defaultImageSettings = () => ({ format: "original", maxSizeKb: "", jpegConfirmed: false });

  const updateImageSetting = (index, key, value) => {
    setImageSettings((current) => current.map((setting, settingIndex) => {
      const applyToSetting = settingIndex === index || (key === "format" && sameConversion) || (key === "maxSizeKb" && sameSize) || (key === "jpegConfirmed" && sameConversion);
      if (!applyToSetting) return setting;
      return { ...setting, [key]: value, ...(key === "format" && value !== "jpeg" ? { jpegConfirmed: false } : {}) };
    }));
  };

  const toggleSameConversion = (checked) => {
    setSameConversion(checked);
    if (!checked || !imageSettings.length) return;
    const current = imageSettings[activeImageIndex] || { format: "original", jpegConfirmed: false };
    setImageSettings((settings) => settings.map((setting) => ({ ...setting, format: current.format, jpegConfirmed: current.format === "jpeg" ? current.jpegConfirmed : false })));
  };

  const toggleSameSize = (checked) => {
    setSameSize(checked);
    if (!checked || !imageSettings.length) return;
    const current = imageSettings[activeImageIndex] || { maxSizeKb: "" };
    setImageSettings((settings) => settings.map((setting) => ({ ...setting, maxSizeKb: current.maxSizeKb })));
  };

  const handleImageFiles = (candidates, replace = false) => {
    const incoming = Array.from(candidates || []);
    if (!incoming.length) return;
    const invalid = incoming.find((file) => !isSupportedImageFile(file));
    if (invalid) { setError(`${invalid.name || "One selected file"} is not a supported image. Choose JPG, PNG, HEIC, TIFF, GIF, or BMP.`); return; }
    if (incoming.some((file) => file.size > 25 * 1024 * 1024)) { setError("Each image must be 25 MB or smaller."); return; }
    const existing = replace ? [] : imageFiles;
    const additions = incoming.filter((file) => !existing.some((current) => current.name === file.name && current.size === file.size && current.lastModified === file.lastModified));
    const next = [...existing, ...additions];
    if (next.length > maxImageFiles) { setError(`Choose up to ${maxImageFiles} images per request.`); return; }
    setImageFiles(next);
    setActiveImageIndex((current) => replace ? 0 : Math.min(current, Math.max(next.length - 1, 0)));
    if (replace) { setSameConversion(false); setSameSize(false); }
    setImageSettings((current) => {
      const base = replace ? [] : current.slice(0, existing.length);
      return [...base, ...additions.map(defaultImageSettings)];
    });
    setPreviewUrl("");
    setPreviewError(false);
    setError("");
  };

  const removeImageFile = (index) => {
    setActiveImageIndex((active) => Math.min(active, Math.max(imageFiles.length - 2, 0)));
    setImageFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
    setImageSettings((current) => current.filter((_, settingIndex) => settingIndex !== index));
    setError("");
  };

  const handleSourceFile = (file) => {
    if (isImage) {
      handleImageFiles([file], true);
      return;
    }
    setSource(file);
    setError("");
  };

  const reset = () => {
    if (jobId && job && (job.status === "queued" || job.status === "processing")) deleteProcessingJob(jobMode, jobId).catch(() => undefined);
    if (batchJobs) batchJobs.filter((entry) => entry.status === "queued" || entry.status === "processing").forEach((entry) => deleteProcessingJob(jobMode, entry.id).catch(() => undefined));
    setSource(null); setImageFiles([]); setImageSettings([]); setActiveImageIndex(0); setSameConversion(false); setSameSize(false); setReference(null); setMethod("auto"); setCompressionProfile("balanced"); setCustomQuality(72); setRemoveColor(false); setCustomTargetMb(""); setUploadProgress(0); setJobId(null); setJob(null); setBatchJobs(null); setError(""); setPreviewUrl(""); setPreviewError(false); setKeepResult(false);
  };

  useEffect(() => {
    if (!isImage) return undefined;
    const handlePaste = (event) => {
      if (event.defaultPrevented || busy || uploadProgress) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const file = clipboardImageFile(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      handleImageFiles([file]);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [isImage, busy, uploadProgress, handleImageFiles]);

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
    if (!(isImage ? imageFiles.length : source)) { setError(`Choose a ${isImage ? "source image" : isPdfCompressor ? "PDF" : "video"} first.`); return; }
    if (!isProcessingLocationReady(locations, processingMode)) { setError(processingMode === "local" ? "Admin login or activation is required in the Local agent dashboard." : "Server processing is unavailable. Choose Local agent after authorizing it."); return; }
    if (isImage && imageFiles.length > maxImageFiles) { setError(`Choose up to ${maxImageFiles} images per request.`); return; }
    if (isImage && imageSettings.some((setting) => setting.maxSizeKb && (!/^\d+$/.test(setting.maxSizeKb) || Number(setting.maxSizeKb) <= 0))) { setError("Enter a positive whole number of KB for every image with a size target."); return; }
    if (isImage && imageSettings.some((setting) => setting.format === "jpeg" && !setting.jpegConfirmed)) { setError("Confirm the JPEG transparency warning for every JPG output."); return; }
    if (isPdfCompressor && !pdfCompressionProfiles.some(([value]) => value === compressionProfile)) { setError("Choose a supported compression level."); return; }
    if (isPdfCompressor && compressionProfile === "custom" && (!Number.isFinite(Number(customQuality)) || Number(customQuality) < 25 || Number(customQuality) > 90)) { setError("Choose a custom image quality between 25 and 90."); return; }
    if (isPdfCompressor && compressionProfile === "custom" && customTargetMb !== "" && (!Number.isFinite(Number(customTargetMb)) || Number(customTargetMb) < 1 || Number(customTargetMb) > 200)) { setError("Choose a custom target size between 1 and 200 MB."); return; }
    const form = new FormData();
    form.append("tool", tool);
    if (isImage) imageFiles.forEach((file) => form.append("source", file, file.name));
    else form.append("source", source, source.name);
    if (isImage) {
      form.append("imageOptions", JSON.stringify(imageFiles.map((file, index) => ({ format: imageSettings[index]?.format || "original", method, maxSizeKb: imageSettings[index]?.maxSizeKb || "", jpegConfirmed: Boolean(imageSettings[index]?.jpegConfirmed) }))));
      form.append("method", method);
    } else if (isPdfCompressor) {
      form.append("compressionProfile", compressionProfile);
      form.append("customQuality", String(customQuality));
      form.append("removeColor", removeColor ? "1" : "0");
      form.append("customTargetMb", String(customTargetMb));
    } else if (reference) form.append("reference", reference, reference.name);
    if (processingMode === "local") form.append("retention", keepResult ? "keep" : "delete");
    try {
      setUploadProgress(1);
      const response = await uploadWithProgress(form, processingMode, setUploadProgress);
      setUploadProgress(0);
      setJobMode(processingMode);
      const ids = Array.isArray(response.jobIds) ? response.jobIds : [response.jobId];
      if (isImage && ids.length > 1) {
        setBatchJobs(ids.map((id) => ({ id, status: "queued", progress: 0, stage: "Queued", message: "Waiting for the worker.", logs: [], warnings: [], error: null, result: null })));
      } else {
        setJobId(ids[0]);
        setJob({ id: ids[0], status: "queued", progress: 0, stage: "Queued", message: "Waiting for the worker.", logs: [], warnings: [], error: null, result: null });
      }
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
    <div className="capability-strip"><div className="capability-main"><span className={`capability-dot ${capabilities?.status === "ready" ? "ready" : ""}`} /><span>{capabilities?.status === "ready" ? `${processingMode === "local" ? "Local agent" : "Server"} worker online` : "Connecting to processing worker"}</span></div>{isImage ? <span>{heicReady ? (capabilities?.image?.heic ? "HEIC enabled" : "HEIC enabled via local fallback") : capabilities?.status === "ready" ? "HEIC unavailable" : "HEIC capability checking"}</span> : isPdfCompressor ? <span>{capabilities?.status !== "ready" ? "PDF compression capability checking" : pdfCompressorReady ? "PDF compression ready" : "PDF structural optimization fallback"}</span> : <span>{capabilities?.video?.untrunc ? (serverReferenceReady ? "Reference recovery + fallback" : "Reference recovery · upload a reference") : capabilities?.status === "ready" ? "FFmpeg recovery enabled · reference recovery unavailable" : "Video capabilities checking"}</span>}</div>
    {job ? <JobStatusCard job={job} isImage={isImage} isPdfCompressor={isPdfCompressor} mode={jobMode} keepResult={keepResult} onReset={reset} /> : batchJobs ? <BatchJobStatusCard jobs={batchJobs} mode={jobMode} onReset={reset} /> : <div className="workspace-grid">
      <section className="tool-card primary-card"><div className="card-heading"><div><span className="card-index">01</span><h2>{isImage ? "Add up to 5 images" : isPdfCompressor ? "Add a PDF" : "Add a damaged video"}</h2></div><span className="required-label">Required</span></div><FileDropzone files={isImage ? imageFiles : undefined} file={isImage ? undefined : source} onFiles={isImage ? handleImageFiles : undefined} onFile={isImage ? undefined : (file) => { setSource(file); setError(""); }} onRemoveFile={isImage ? removeImageFile : undefined} onClear={() => { setSource(null); setImageFiles([]); setImageSettings([]); setActiveImageIndex(0); setSameConversion(false); setSameSize(false); setPreviewUrl(""); setPreviewError(false); }} multiple={isImage} variant={isImage ? "image" : isPdfCompressor ? "pdf" : "video"} accept={isImage ? imageAccept : isPdfCompressor ? ".pdf,application/pdf" : "video/*,.mkv,.webm,.avi,.3gp"} label={isImage ? "Drop up to 5 images here" : isPdfCompressor ? "Drop a PDF here" : "Drop a video here"} hint={isImage ? "or click to browse · paste an image directly" : "or click to browse from your device"} required disabled={Boolean(uploadProgress)} />{isImage && imageFiles[0] && previewUrl && <div className="image-preview-card"><div className="preview-heading"><span>First image preview</span><small>Local only · not uploaded</small></div><div className="image-preview-frame">{previewError ? <DismissibleMessage className="preview-unavailable" resetKey={`${imageFiles[0].name}-preview`}><AlertTriangle size={18} /><span>This browser cannot preview this image format, but the file can still be processed.</span></DismissibleMessage> : <img src={previewUrl} alt={`Preview of ${imageFiles[0].name}`} onError={() => setPreviewError(true)} />}</div></div>}<div className="limit-row"><span>Maximum file size</span><strong>{isImage ? "25 MB each · 5 per request" : isPdfCompressor ? "200 MB" : "2 GB"}</strong></div>{processingMode === "local" && <label className="keep-result-check"><input type="checkbox" checked={keepResult} onChange={(event) => setKeepResult(event.target.checked)} /><span>Keep final result on this device</span></label>}</section>
    {isImage ? <ImageSettingsCard files={imageFiles} settings={imageSettings} activeIndex={activeImageIndex} sameConversion={sameConversion} sameSize={sameSize} method={method} capabilities={capabilities} imageMagickReady={imageMagickReady} sipsReady={sipsReady} onChange={updateImageSetting} onActiveIndexChange={setActiveImageIndex} onSameConversionChange={toggleSameConversion} onSameSizeChange={toggleSameSize} onMethodChange={setMethod} /> : isPdfCompressor ? <PdfCompressionSettingsCard source={source} profile={compressionProfile} customQuality={customQuality} removeColor={removeColor} customTargetMb={customTargetMb} estimate={compressionEstimate} onChange={setCompressionProfile} onCustomQualityChange={setCustomQuality} onRemoveColorChange={setRemoveColor} onCustomTargetChange={setCustomTargetMb} capabilities={capabilities} /> : <section className="tool-card settings-card"><div className="card-heading"><div><span className="card-index">02</span><h2>Reference video</h2></div><span className={serverReferenceReady ? "optional-label" : "required-label"}>{serverReferenceReady ? "Optional server fallback" : "Upload for damaged MP4"}</span></div><p className="card-description">A healthy recording from the same device or app can rebuild missing MP4 metadata when it was recorded with the same settings.</p><FileDropzone file={reference} onFile={setReference} onClear={() => setReference(null)} variant="video" accept="video/*,.mkv,.webm,.avi,.3gp" label="Drop a reference video" hint={serverReferenceReady ? "or continue without one" : "required when MP4 metadata is missing"} disabled={Boolean(uploadProgress)} /><div className="info-note"><Info size={16} /><span>{capabilities?.video?.untrunc ? (serverReferenceReady ? "Reference recovery is available. If you do not upload one, the configured server reference will be tried." : "No server-side reference is configured. Upload a healthy recording from the same device or app; readable containers can still be repaired without one.") : "FFmpeg can repair readable containers. Missing MP4 metadata requires Untrunc and a matching healthy reference."}</span></div></section>}
      <section className="tool-card action-card"><div className="action-copy"><div className="action-icon"><Zap size={19} /></div><div><h2>Ready when you are</h2><p>{isImage ? "Your output will be created as a new file." : isPdfCompressor ? "The original PDF stays untouched; a smaller copy is created." : "The worker will try the safest recovery method first."}</p></div></div><button className="primary-button" onClick={submit} disabled={!canSubmit}>{uploadProgress ? <><LoaderCircle className="spin" size={18} /> Uploading {uploadProgress}%</> : <><Sparkles size={18} /> {isImage ? "Convert image" : isPdfCompressor ? "Compress PDF" : "Repair video"}</>}</button></section>
    </div>}
    {!job && !isImage && !isPdfCompressor && <VideoRecoverySummary hasServerReference={serverReferenceReady} hasUntrunc={capabilities?.video?.untrunc} />}
    {error && <DismissibleMessage className="error-banner" resetKey={error}><AlertTriangle size={18} /><span>{error}</span></DismissibleMessage>}
    {!job && !batchJobs && <div className="trust-row"><div><CheckCircle2 size={16} /> No resizing by default</div><div><Clock3 size={16} /> Temporary processing only</div><div><ShieldCheck size={16} /> Private worker pipeline</div></div>}
    </>}
  </AppShell>;
}

function PdfCompressionSettingsCard({ source, profile, customQuality, removeColor, customTargetMb, estimate, onChange, onCustomQualityChange, onRemoveColorChange, onCustomTargetChange, capabilities }) {
  const compressionReady = capabilities?.pdf?.compressor !== false;
  const compressionEngine = capabilities?.pdf?.compressorEngine || "the bundled PDF optimizer";
  return <section className="tool-card settings-card pdf-compression-settings-card">
    <div className="card-heading"><div><span className="card-index">02</span><h2>Choose compression</h2></div><span className="optional-label">PDF quality</span></div>
    <p className="card-description">Choose the balance between file size and image detail. The original stays unchanged; image-heavy pages may be rebuilt as optimized images to match the selected compression quality.</p>
    <div className="format-grid" aria-label="PDF compression profiles">{pdfCompressionProfiles.map(([value, label, detail]) => <button type="button" key={value} className={`format-option ${profile === value ? "selected" : ""}`} onClick={() => onChange(value)}><span className="format-radio" /><strong>{label}</strong><small>{detail}</small></button>)}</div>
    {profile === "custom" && <div className="pdf-custom-controls">
      <label className="field-label" htmlFor="pdf-custom-target"><span>Target file size</span><strong>Optional</strong></label>
      <div className="input-with-suffix"><input id="pdf-custom-target" type="number" min="1" max="200" step="0.1" inputMode="decimal" value={customTargetMb} onChange={(event) => onCustomTargetChange(event.target.value.replace(/[^0-9.]/g, ""))} placeholder="e.g. 25" aria-label="Custom target PDF size in megabytes" /><span>MB target</span></div>
      <label className="field-label" htmlFor="pdf-custom-quality"><span>Image quality</span><strong>{customQuality} · {compressionQualityLabel(customQuality)}</strong></label>
      <input id="pdf-custom-quality" className="pdf-quality-range" type="range" min="25" max="90" step="1" value={customQuality} onChange={(event) => onCustomQualityChange(Number(event.target.value))} aria-label="Custom image quality" />
      <label className="pdf-custom-toggle"><span><strong>Remove color from images</strong><small>Convert rasterized images to grayscale for a smaller result.</small></span><input type="checkbox" checked={removeColor} onChange={(event) => onRemoveColorChange(event.target.checked)} /></label>
    </div>}
    <PdfCompressionEstimate source={source} profile={profile} customQuality={customQuality} removeColor={removeColor} customTargetMb={customTargetMb} estimate={estimate} />
    <div className="info-note"><Info size={16} /><span>{compressionReady ? `The worker will use ${String(compressionEngine).toLowerCase()}, preserve searchable text where possible, and keep the original if the selected pass would make the file larger.` : "The worker can still create a safe structural PDF rewrite, but stronger embedded-image compression is unavailable."}</span></div>
  </section>;
}

function PdfCompressionEstimate({ source, profile, customQuality, removeColor, customTargetMb, estimate: estimateState }) {
  const fallback = estimatePdfCompression(source, profile, customQuality, removeColor, customTargetMb);
  const loading = estimateState?.status === "loading";
  const estimate = estimateState?.data || (!loading ? fallback : null);
  if (!estimate) return <div className="pdf-compression-estimate empty"><strong>Estimated new file size</strong><span>{loading ? "Analyzing page samples for a closer estimate..." : "Add a PDF above to see an estimate."}</span></div>;
  const fillPercent = Math.max(5, Math.min(100, Math.round((estimate.estimatedBytes / estimate.originalBytes) * 100)));
  const statusText = estimate.target
    ? "Custom target; the worker will iterate validated compression passes."
    : estimateState?.status === "loading"
    ? "Analyzing page samples for a closer estimate..."
    : estimateState?.status === "fallback"
      ? "Quick estimate; detailed page sampling was unavailable."
      : estimate.sampled
        ? `Sampled ${estimate.sampledPages} page${estimate.sampledPages === 1 ? "" : "s"} from ${estimate.pageCount} pages.`
        : "Based on the selected compression profile.";
  return <div className="pdf-compression-estimate" aria-live="polite">
    <strong>Estimated new file size</strong>
    <div className="pdf-compression-estimate-value"><strong>~{formatBytes(estimate.estimatedBytes)}</strong><del>{formatBytes(estimate.originalBytes)}</del><span>(-{estimate.reductionPercent}%)</span></div>
    <div className="pdf-compression-estimate-bar" aria-hidden="true"><span style={{ width: `${fillPercent}%` }} /></div>
    <small>{statusText} Actual size depends on the content.</small>
  </div>;
}

function ImageSettingsCard({ files, settings, activeIndex, sameConversion, sameSize, method, capabilities, imageMagickReady, sipsReady, onChange, onActiveIndexChange, onSameConversionChange, onSameSizeChange, onMethodChange }) {
  const activeFile = files[activeIndex];
  const activeSetting = settings[activeIndex] || { format: "original", maxSizeKb: "", jpegConfirmed: false };
  const selectImage = (index) => onActiveIndexChange(Math.max(0, Math.min(index, files.length - 1)));
  return <section className="tool-card settings-card image-batch-settings-card">
    <div className="card-heading"><div><span className="card-index">02</span><h2>{files.length ? "Set output" : "Choose output"}</h2></div><span className="optional-label">{files.length > 1 ? `${activeIndex + 1} of ${files.length}` : "Per-image target"}</span></div>
    <p className="card-description">Choose a conversion and optional KB target for the selected image. Pixel dimensions stay unchanged.</p>
    {!files.length ? <div className="batch-settings-empty"><Info size={18} /><span>Add images above to configure each output.</span></div> : <>
      <div className="image-settings-pager" aria-label="Select image to configure">
        <button className="image-settings-pager-arrow" type="button" onClick={() => selectImage(activeIndex - 1)} disabled={activeIndex === 0} aria-label="Previous image" title="Previous image"><ChevronLeft size={16} /></button>
        <div className="image-settings-page-buttons" role="tablist" aria-label="Images">
          {files.map((file, index) => <button className={`image-settings-page-button ${index === activeIndex ? "active" : ""}`} type="button" role="tab" aria-selected={index === activeIndex} aria-label={`Configure image ${index + 1}: ${file.name}`} title={file.name} onClick={() => selectImage(index)} key={`${file.name}-${file.size}-${index}`}>{index + 1}</button>)}
        </div>
        <button className="image-settings-pager-arrow" type="button" onClick={() => selectImage(activeIndex + 1)} disabled={activeIndex === files.length - 1} aria-label="Next image" title="Next image"><ChevronRight size={16} /></button>
      </div>
      <div className="image-settings-current-file"><strong title={activeFile.name}>{activeFile.name}</strong><span>{formatBytes(activeFile.size)} · Image {activeIndex + 1} of {files.length}</span></div>
      {files.length > 1 && <div className="image-settings-sync" aria-label="Apply settings to all images">
        <label><input type="checkbox" checked={sameConversion} onChange={(event) => onSameConversionChange(event.target.checked)} /><span><strong>Conversion</strong> Make it same for all images</span></label>
        <label><input type="checkbox" checked={sameSize} onChange={(event) => onSameSizeChange(event.target.checked)} /><span><strong>Size</strong> Keep it same for all images</span></label>
      </div>}
      <div className="format-grid">{imageFormats.map(([value, label, detail]) => <button type="button" key={value} className={`format-option ${activeSetting.format === value ? "selected" : ""}`} onClick={() => onChange(activeIndex, "format", value)}><span className="format-radio" /><strong>{label}</strong><small>{detail}</small></button>)}</div>
      <label className="field-label" htmlFor="active-image-size">Target size <span>KB</span></label>
      <div className="input-with-suffix"><input id="active-image-size" type="text" inputMode="numeric" value={activeSetting.maxSizeKb} onChange={(event) => onChange(activeIndex, "maxSizeKb", event.target.value.replace(/[^0-9]/g, ""))} placeholder="Leave blank for normal quality" aria-label={`Target size for ${activeFile.name}`} /><span>KB target</span></div>
      {activeSetting.format === "jpeg" && <label className="warning-check"><input type="checkbox" checked={Boolean(activeSetting.jpegConfirmed)} onChange={(event) => onChange(activeIndex, "jpegConfirmed", event.target.checked)} /><span><AlertTriangle size={16} /><span>JPEG flattens transparent pixels.{sameConversion ? " I understand for all images." : " I understand."}</span></span></label>}
    </>}
    {files.length > 0 && <><label className="field-label">Processing method <span>Worker engine for all images</span></label><div className="method-list">{imageMethods.map(([value, label, detail, tag]) => { const unavailable = (value === "imagemagick" && capabilities?.status === "ready" && !imageMagickReady) || (value === "sips" && capabilities?.status === "ready" && !sipsReady); return <button type="button" key={value} className={`method-option ${method === value ? "selected" : ""} ${unavailable ? "unavailable" : ""}`} disabled={unavailable} onClick={() => onMethodChange(value)}><span className="method-copy"><strong>{label}</strong><small>{detail}</small></span><span className="method-tag">{unavailable ? "Unavailable" : tag}</span></button>; })}</div></>}
  </section>;
}

function BatchJobStatusCard({ jobs, mode, onReset }) {
  const completed = jobs.filter((entry) => entry.status === "completed").length;
  const failed = jobs.filter((entry) => entry.status === "failed").length;
  const finished = completed + failed === jobs.length;
  return <section className={`job-card batch-job-card ${failed ? "failed" : finished ? "success" : ""}`}>
    <div className="job-topline"><span className="job-status-pill">{finished ? (failed ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />) : <LoaderCircle className="spin" size={15} />}{finished ? (failed ? "Batch finished with errors" : "Batch complete") : "Batch processing"}</span><span className="job-id">{completed}/{jobs.length} complete</span></div>
    <div className="job-icon">{finished && !failed ? <CheckCircle2 size={30} /> : <LoaderCircle className={finished ? "" : "spin"} size={30} />}</div>
    <h2>{finished ? (failed ? "Some images need attention" : "Your images are ready") : "Converting your images"}</h2>
    <p className="job-message">Each image is processed independently with the extension and size target you selected.</p>
    <div className="batch-job-list">{jobs.map((entry, index) => {
      const done = entry.status === "completed" && entry.result;
      const itemFailed = entry.status === "failed";
      const progress = Math.max(0, Math.min(100, Number(entry.progress) || 0));
      return <article className={`batch-job-row ${done ? "complete" : itemFailed ? "failed" : ""}`} key={entry.id}>
        <div className="batch-job-row-status">{done ? <CheckCircle2 size={17} /> : itemFailed ? <AlertTriangle size={17} /> : <LoaderCircle className="spin" size={17} />}<span>{index + 1}</span></div>
        <div className="batch-job-row-copy"><strong title={entry.result?.filename || entry.message}>{entry.result?.filename || `Image ${index + 1}`}</strong><span>{done ? `${formatBytes(entry.result.bytes)} · ready` : itemFailed ? entry.error || "Conversion failed." : `${entry.stage || "Queued"} · ${progress}%`}</span></div>
        {done && <BatchDownloadAction result={entry.result} />}
      </article>;
    })}</div>
    <div className="job-actions"><button className="secondary-button" onClick={onReset}><RotateCcw size={17} /> {finished ? "Convert more images" : "Cancel batch"}</button></div>
  </section>;
}

function BatchDownloadAction({ result }) {
  const [filenameStemValue, setFilenameStemValue] = useState(() => filenameStem(result?.filename));
  const filename = downloadFilename(filenameStemValue, result?.filename);
  return <div className="batch-download-action"><ResultFilenameField originalFilename={result.filename} value={filenameStemValue} onChange={setFilenameStemValue} /><a className="secondary-button" href={downloadUrlWithFilename(result.downloadUrl, filename)} download={filename}><Download size={16} /> Download</a></div>;
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

function JobStatusCard({ job, isImage, isPdfCompressor, mode, keepResult, onReset }) {
  const [filenameStemValue, setFilenameStemValue] = useState("");
  const done = job.status === "completed";
  const failed = job.status === "failed";
  const bestEffort = done && (job.warnings || []).some((warning) => /damaged frames/i.test(warning));
  const progress = Math.max(0, Math.min(100, job.progress));
  const filename = done && job.result ? downloadFilename(filenameStemValue || filenameStem(job.result.filename), job.result.filename) : "";
  return <section className={`job-card ${done ? "success" : failed ? "failed" : ""}`}>
    <div className="job-topline"><span className="job-status-pill">{done ? <CheckCircle2 size={15} /> : failed ? <AlertTriangle size={15} /> : <LoaderCircle className="spin" size={15} />}{done ? (bestEffort ? "Best effort" : "Complete") : failed ? "Needs attention" : job.status === "queued" ? "Queued" : "Processing"}</span><span className="job-id">Job {job.id.slice(0, 8)}</span></div>
    <div className="job-icon">{done ? <FileCheck2 size={30} /> : failed ? <AlertTriangle size={30} /> : <LoaderCircle className="spin" size={30} />}</div>
    <h2>{done ? (bestEffort ? "Best-effort result created" : "Your file is ready") : failed ? "We could not complete this job" : job.stage}</h2>
    <p className="job-message">{failed ? job.error : job.message}</p>
    {!done && !failed && <>
      <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
      <div className="progress-meta"><span>{job.stage}</span><strong>{progress}%</strong></div>
      {!isImage && !isPdfCompressor && <ConversionProgress conversion={job.conversion} />}
    </>}
    <JobLogPanel logs={job.logs || []} />
    {done && job.result && isImage && <ResultImagePreview result={job.result} />}
    {done && job.result && !isImage && !isPdfCompressor && <ResultVideoPreview result={job.result} />}
    {done && job.result && isPdfCompressor && <ResultPdfPreview result={job.result} />}
    {done && job.result && <div className="result-summary"><div><span>Output</span><strong>{job.result.filename}</strong></div><div><span>Size</span><strong>{formatBytes(job.result.bytes)}</strong></div>{isPdfCompressor && Number.isFinite(job.result.reductionPercent) && <div><span>Saved</span><strong>{job.result.reductionPercent > 0 ? `${job.result.reductionPercent}%` : "Already optimized"}</strong></div>}{isImage && job.result.targetSizeKb && <div><span>Size target</span><strong>{job.result.targetMet ? `Near ${job.result.targetSizeKb} KB` : "Not reached"}</strong></div>}{isImage && job.result.width && <div><span>Resolution</span><strong>{job.result.width} × {job.result.height}</strong></div>}<div><span>Method</span><strong>{job.result.method || "Completed"}</strong></div></div>}
    {job.warnings.length > 0 && <div className="warning-list">{job.warnings.map((warning) => <DismissibleMessage key={warning} resetKey={warning}><AlertTriangle size={16} /><span>{warning}</span></DismissibleMessage>)}</div>}
    {done && job.result && <ResultDownloadNote result={job.result} mode={mode} keepResult={keepResult} filename={filename} />} {done && job.result && <ResultFilenameField originalFilename={job.result.filename} value={filenameStemValue || filenameStem(job.result.filename)} onChange={setFilenameStemValue} />}<div className="job-actions">{done && job.result && <a className="primary-button" href={downloadUrlWithFilename(job.result.downloadUrl, filename)} download={filename}><Download size={18} /> Download result</a>}<button className="secondary-button" onClick={onReset}><RotateCcw size={17} /> {done || failed ? "Process another file" : "Cancel"}</button></div>
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
  return <div className="result-image-preview"><div className="preview-heading"><span>Converted preview</span><small>Rendered from worker output</small></div><div className="result-preview-frame">{previewError ? <DismissibleMessage className="preview-unavailable" resetKey={`${result.filename}-preview`}><AlertTriangle size={18} /><span>This browser cannot preview {result.filename}, but the converted file is ready to download.</span></DismissibleMessage> : <img src={result.previewUrl || `${result.downloadUrl}?preview=1`} alt={`Converted preview of ${result.filename}`} onError={() => setPreviewError(true)} />}</div></div>;
}

function ResultPdfPreview({ result }) {
  return <div className="result-pdf-preview"><div className="preview-heading"><span>Compressed PDF preview</span><small>Check the first page before downloading</small></div><iframe src={result.previewUrl || `${result.downloadUrl}?preview=1`} title={`Preview of ${result.filename}`} /></div>;
}

function ResultVideoPreview({ result }) {
  const [previewError, setPreviewError] = useState(false);
  const previewUrl = result.previewUrl || `${result.downloadUrl}?preview=1`;
  return <div className="result-video-preview"><div className="preview-heading"><span>Repaired preview</span><small>Check the video before downloading</small></div><div className="result-video-frame">{previewError ? <DismissibleMessage className="preview-unavailable" resetKey={`${result.filename}-preview`}><AlertTriangle size={18} /><span>This browser cannot play this MP4, but the repaired file is ready to download.</span></DismissibleMessage> : <video controls preload="metadata" playsInline onError={() => setPreviewError(true)} aria-label={`Preview of ${result.filename}`}><source src={previewUrl} type="video/mp4" /></video>}</div></div>;
}

function formatLogTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function JobLogPanel({ logs }) {
  return <div className="job-log-panel"><div className="job-log-heading"><span><span className="log-live-dot" /> Worker log</span><span>{logs.length} events</span></div><div className="job-log-list" aria-live="polite">{logs.length ? logs.map((entry, index) => <div className={`job-log-entry ${entry.level === "error" ? "error" : ""}`} key={`${entry.time}-${index}`}><time>{formatLogTime(entry.time)}</time><span>{entry.message}</span></div>) : <div className="job-log-empty">Waiting for the worker to report progress…</div>}</div></div>;
}
