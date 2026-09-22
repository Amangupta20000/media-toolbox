"use client";

import { Globe2, Laptop, LockKeyhole, ShieldCheck } from "lucide-react";
import { browserSupportsTool } from "./browser-processing.js";
import { isProcessingLocationReady } from "./processing-client.js";
import { pushAnalyticsEvent } from "../lib/analytics.js";

const toolNames = {
  "image-converter": "image conversion",
  "svg-to-png": "SVG to PNG conversion",
  "video-repair": "video repair",
  "video-compressor": "video compression",
  "audio-extractor": "audio extraction",
  "pdf-to-images": "PDF to images",
  "pdf-editor": "PDF editing",
  "pdf-text-editor": "PDF text editing",
  "pdf-compressor": "PDF compression",
};

const formatSupport = {
  "image-converter": {
    input: { local: "JPG/JPEG, PNG, HEIC/HEIF, TIFF/TIF, GIF, BMP", browser: "Browser-decodable JPG/JPEG, PNG, GIF, BMP; accepted files can also be copied as Original" },
    output: { local: "Original, JPG, PNG, HEIC, TIFF, GIF, BMP", browser: "Original copy, PNG, JPG" },
  },
  "svg-to-png": {
    input: { local: "SVG file or pasted SVG markup", browser: "SVG file or pasted SVG markup" },
    output: { local: "PNG at 1×, 2×, 3×, 4×, or custom dimensions", browser: "PNG at 1×, 2×, 3×, or 4×; Custom uses desktop processing" },
  },
  "pdf-compressor": {
    input: { local: "PDF", browser: "PDF up to 10 MB and 100 pages" },
    output: { local: "Compressed PDF", browser: "Compressed PDF using the Balanced profile; image-heavy pages may lose selectable text" },
  },
  "video-repair": {
    input: { local: "MP4, M4V, MOV, 3GP, MKV, WebM, AVI, MPEG, MPG", browser: "Not supported — video repair requires the Local agent" },
    output: { local: "Repaired video in the recovered format", browser: "Not supported" },
  },
  "video-compressor": {
    input: { local: "MP4, M4V, MOV, 3GP, MKV, WebM, AVI, MPEG, MPG", browser: "Not supported — video compression requires the Local agent" },
    output: { local: "Compressed MP4", browser: "Not supported" },
  },
  "audio-extractor": {
    input: { local: "MP4, M4V, MOV, 3GP, MKV, WebM, AVI, MPEG, MPG with an audio track", browser: "Not supported — audio extraction requires the Local agent" },
    output: { local: "MP3, WAV, AAC, FLAC, or M4A", browser: "Not supported" },
  },
  "pdf-to-images": {
    input: { local: "PDF up to 200 MB and 300 pages", browser: "Not supported — PDF rendering requires the Local agent" },
    output: { local: "ZIP archive containing PNG or JPG page images", browser: "Not supported" },
  },
  "pdf-editor": {
    input: { local: "PDF; added images: PNG, JPG/JPEG, HEIC/HEIF, TIFF/TIF, GIF, BMP", browser: "PDFs up to 50 MB total; added images: PNG, JPG, or JPEG up to 1 MB each" },
    output: { local: "PDF", browser: "Download-only PDF from imported or blank pages" },
  },
  "pdf-text-editor": {
    input: { local: "PDF with selectable text or OCR-detectable scans", browser: "One PDF up to 25 MB and 100 pages; selectable embedded text only" },
    output: { local: "PDF", browser: "Download-only edited PDF; original styling and placement preserved" },
  },
};

function formatRowsFor(tool) {
  const support = formatSupport[tool] || {
    input: { local: "See this tool’s upload area", browser: "See this tool’s upload area" },
    output: { local: "See this tool’s upload area", browser: "See this tool’s upload area" },
  };
  return [
    ["Input", support.input.local, support.input.browser],
    ["Output", support.output.local, support.output.browser],
  ];
}

function comparisonRowsFor(tool, browserSupported, localAdmin = false) {
  const supportRows = formatRowsFor(tool);
  const browserBestFor = browserSupported
    ? tool === "pdf-compressor" ? "Quick PDF compression up to 10 MB and 100 pages"
      : tool === "pdf-editor" ? "Quick PDF import, merging, and page arrangement with PNG/JPG/JPEG images up to 1 MB each"
        : tool === "pdf-text-editor" ? "Quick replacement of selectable embedded PDF text up to 25 MB and 100 pages"
        : "Quick conversions on mobile or desktop"
    : tool === "video-compressor" ? "Local agent video compression with quality and size presets"
      : tool === "audio-extractor" ? "Extracting an audio track from a supported video"
        : tool === "pdf-to-images" ? "Rendering PDF pages into a downloadable image archive"
          : "Not supported for this tool";
  const browserFiles = browserSupported ? "Files stay in this browser; nothing is uploaded" : "Requires the Local agent";
  const browserResults = browserSupported ? "Download-only; temporary in this tab" : "Not available";
  const browserRequirements = browserSupported ? "No installation; browser memory and format support apply" : "Requires the Local agent on a desktop computer";
  const imageSizeRows = tool === "image-converter" ? [["Maximum input size", "25 MB per image", "5 MB per image"]] : [];
  const toolSpecificRows = tool === "video-compressor"
    ? [["Compression profiles", "Balanced, Small file, or Higher quality", "Local agent only", true], ["Output", "New MP4 copy; original remains untouched", "Not available", true], ["Maximum input size", "2 GB", "Not available", true]]
    : tool === "audio-extractor"
      ? [["Audio formats", "MP3, WAV, AAC, FLAC, or M4A", "Local agent only", true], ["Audio track", "First audio track from the video", "Not available", true], ["Maximum input size", "2 GB", "Not available", true]]
      : tool === "pdf-to-images"
        ? [["Output scale", "1×, 1.5×, or 2×", "Local agent only", true], ["Archive", "One ZIP containing numbered page images", "Not available", true], ["PDF page limit", "300 pages", "Not available", true]]
        : tool === "svg-to-png"
    ? [["Export sizing", "1×, 2×, 3×, 4×, or Custom", "1×, 2×, 3×, or 4× (Custom uses desktop processing)"]]
    : tool === "pdf-compressor"
      ? [["Compression profiles", "Balanced, Smallest file, Higher quality, or Custom", "Balanced only"]]
      : tool === "pdf-editor"
        ? [
          ["Local PDF limit", localAdmin ? "Unlimited PDF count and file size for Admin" : "Up to 5 PDFs · 200 MB total", "Up to 5 PDFs · 50 MB total"],
          ["Import existing PDFs", "Available", "Available"],
          ["Merge existing PDFs", "Available", "Available"],
          ["Duplicate page", "Available", "Local agent only", true],
          ["Text boxes", "Available", "Local agent only", true],
          ["Password-protected PDFs", "Available where supported", "Local agent only", true],
          ["OCR and searchable text editing", "Available", "Local agent only", true],
          ["Save to device and History", "Available", "Local agent only", true],
          ["Browser image limit", "25 MB per image", "1 MB per image"],
          ["Browser image formats", "PNG, JPG/JPEG, HEIC/HEIF, TIFF/TIF, GIF, BMP", "PNG, JPG, JPEG only"],
          ["Browser PDF total", "200 MB total", "50 MB total"],
          ["Browser result", "Local result workflow", "Download-only; temporary in this tab"],
        ]
      : tool === "pdf-text-editor"
        ? [
          ["Open and preview one PDF", "Available", "Available"],
          ["Select embedded text", "Available", "Available"],
          ["Text replacement", "Available", "Available"],
          ["Text formatting", "Available", "Local agent only", true],
          ["Text placement", "Available", "Local agent only", true],
          ["OCR and scanned PDF editing", "Available", "Local agent only", true],
          ["Password-protected PDFs", "Available where supported", "Local agent only", true],
          ["PDF size limit", "200 MB per PDF", "25 MB per PDF"],
          ["PDF page limit", "Local agent limit applies", "100 pages"],
          ["Browser result", "Local result workflow", "Download-only; temporary in this tab"],
        ]
      : [];
  return [
    ["Best for", "Desktop users, large files, PDF editing, OCR, compression, video repair, and full native format support", browserBestFor],
    ["File handling", "Files stay on this computer", browserFiles],
    ["Results", "Can save results in the Local agent Results folder", browserResults],
    ["Requirements", "NativeMedia Agent and authorization", browserRequirements],
    ...imageSizeRows,
    ...toolSpecificRows,
    ...supportRows,
  ];
}

export function ProcessingOptionsPanel({ tool, locations, value, onSelect, hidden = false }) {
  const localReady = isProcessingLocationReady(locations, "local");
  const browserSupported = browserSupportsTool(tool);
  const browserReady = browserSupported && (locations?.browser ? isProcessingLocationReady(locations, "browser") : true);
  const localAdmin = tool === "pdf-editor" && (locations?.local?.authorization?.mode === "admin" || locations?.local?.health?.authorization?.mode === "admin");
  const toolName = toolNames[tool] || "this tool";

  return <section className="processing-options-panel" role="tabpanel" hidden={hidden} aria-labelledby="processing-options-title">
    <div className="processing-options-intro">
      <div className="section-kicker"><span className="kicker-line" /> Choose how files run</div>
      <h2 id="processing-options-title">Local agent is the recommended choice</h2>
      <p>Choose the option that fits your device and the kind of {toolName} you need. Local agent is best for desktop and advanced work; Browser mode is a convenient option for supported quick conversions.</p>
    </div>
    <div className="processing-format-table-wrap">
      <table className="processing-format-table">
        <caption>How processing modes differ</caption>
        <thead><tr><th scope="col">Comparison</th><th scope="col"><span className="processing-format-heading"><Laptop size={13} aria-hidden="true" /><span className="processing-format-mode"><strong>Local agent</strong><em className="processing-recommended">Recommended</em></span></span></th><th scope="col"><span className="processing-format-heading"><Globe2 size={13} aria-hidden="true" /><span className="processing-format-mode"><strong>Browser mode</strong><em className={browserSupported ? "processing-available" : "processing-unavailable"}>{browserSupported ? "Available for quick tools" : "Not available for this tool"}</em></span></span></th></tr></thead>
        <tbody>{comparisonRowsFor(tool, browserSupported, localAdmin).map(([label, local, browser, browserLocked = false], index) => <tr key={label} style={{ animationDelay: `${index * 55}ms` }}><th scope="row">{label}</th><td>{local}</td><td>{browserLocked ? <span className="processing-locked"><LockKeyhole size={11} aria-hidden="true" /> {browser}</span> : browser}</td></tr>)}<tr className="processing-format-actions" style={{ animationDelay: `${comparisonRowsFor(tool, browserSupported, localAdmin).length * 55}ms` }}><th scope="row">Choose mode</th><td><button className="secondary-button processing-format-action" type="button" disabled={!localReady} aria-pressed={value === "local"} onClick={() => { pushAnalyticsEvent("processing_mode_selected", { tool, mode: "local" }); onSelect("local"); }}>{value === "local" ? "Currently selected" : localReady ? "Use Local agent" : "Start the Local agent"}</button></td><td><button className="secondary-button processing-format-action" type="button" disabled={!browserReady} aria-pressed={value === "browser"} onClick={() => { pushAnalyticsEvent("processing_mode_selected", { tool, mode: "browser" }); onSelect("browser"); }}>{value === "browser" ? "Currently selected" : browserReady ? "Use Browser mode" : "Not supported here"}</button></td></tr></tbody>
      </table>
    </div>
    <div className="processing-options-note"><ShieldCheck size={16} /><span>{browserSupported ? "For the best reliability, use Local agent for large or advanced jobs. Browser mode is intended for quick conversions in supported tools." : "Local agent is required for this tool because the browser cannot reliably provide its advanced processing features."}</span></div>
  </section>;
}
