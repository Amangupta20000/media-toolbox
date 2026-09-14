"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, Download, Eye, FileText, Film, FolderOpen, Image as ImageIcon, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { formatBytes } from "./file-dropzone.jsx";
import { DismissibleMessage } from "./dismissible-message.jsx";
import { rememberHistoryEdit } from "./history-edit.js";
import { deleteDownloadedFile, deleteLocalHistory, deleteServerHistory, getLocalHistory, getServerHistory, openLocalResultsFolder, probeServer } from "./processing-client.js";

const toolNames = {
  "image-converter": "Image conversion",
  "video-repair": "Video repair",
  "pdf-editor": "PDF editing",
  "pdf-text-editor": "PDF text editing",
  "pdf-compressor": "PDF compression",
};

const toolIcons = {
  "image-converter": ImageIcon,
  "video-repair": Film,
  "pdf-editor": FileText,
  "pdf-text-editor": FileText,
  "pdf-compressor": Archive,
};

export function ToolViewTabs({ value, onChange }) {
  return <div className="tool-view-tabs" role="tablist" aria-label="Tool views">
    <button type="button" role="tab" aria-selected={value === "tool"} className={value === "tool" ? "active" : ""} onClick={() => onChange("tool")}>Tool</button>
    <button type="button" role="tab" aria-selected={value === "history"} className={value === "history" ? "active" : ""} onClick={() => onChange("history")}>History</button>
  </div>;
}

function historyDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatDuration(value) {
  const seconds = Math.round(Number(value) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

async function loadLocalHistory(tool) {
  try {
    const payload = await getLocalHistory(tool);
    return { status: "ready", items: Array.isArray(payload.items) ? payload.items : [], message: "" };
  } catch (error) {
    if (error?.status === 404) {
      return { status: "unsupported", items: [], message: "This installed Local agent does not support History. Update the agent application to the latest release." };
    }
    if (error?.status === 401 || error?.status === 402 || error?.status === 403) {
      return { status: "unavailable", items: [], message: error.message || "Accept the legal documents in the Local agent dashboard to view saved history." };
    }
    return { status: "error", items: [], message: error instanceof Error ? error.message : "Local history could not be loaded." };
  }
}

async function loadServerHistory(tool) {
  try {
    await probeServer();
    const payload = await getServerHistory(tool);
    return { status: "ready", items: Array.isArray(payload.items) ? payload.items : [], message: "" };
  } catch (error) {
    if (Number(error?.status) >= 500) {
      return { status: "unavailable", items: [], message: "Server history is unavailable because the server worker or persistent storage is not connected. Use the Local agent or connect a persistent backend." };
    }
    return { status: "error", items: [], message: error instanceof Error ? error.message : "Server history could not be loaded." };
  }
}

export function ToolHistory({ tool }) {
  const [local, setLocal] = useState({ status: "loading", items: [], message: "" });
  const [server, setServer] = useState({ status: "loading", items: [], message: "" });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [previewItem, setPreviewItem] = useState(null);
  const [openingResults, setOpeningResults] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sizeFilter, setSizeFilter] = useState("all");
  const [durationFilter, setDurationFilter] = useState("all");
  const [sortBy, setSortBy] = useState("newest");
  const Icon = toolIcons[tool] || FileText;

  const loadHistory = async () => {
    setLoading(true);
    setMessage("");
    const [localResult, serverResult] = await Promise.all([loadLocalHistory(tool), loadServerHistory(tool)]);
    setLocal(localResult);
    setServer(serverResult);
    setLoading(false);
  };

  useEffect(() => {
    loadHistory().catch(() => undefined);
  }, [tool]);

  const items = [
    ...(local.status === "ready" ? local.items : []).map((item) => ({ ...item, storage: "local" })),
    ...(server.status === "ready" ? server.items : []).map((item) => ({ ...item, storage: "server" })),
  ];

  const filteredItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    const filtered = items.filter((item) => {
      const result = item.result || {};
      const bytes = Number(result.bytes || 0);
      const duration = Number(result.durationMs || 0);
      const haystack = `${result.filename || ""} ${item.location || ""} ${item.storage || ""}`.toLowerCase();
      const sizeMatches = sizeFilter === "all" || (sizeFilter === "small" && bytes < 1024 * 1024) || (sizeFilter === "medium" && bytes >= 1024 * 1024 && bytes < 10 * 1024 * 1024) || (sizeFilter === "large" && bytes >= 10 * 1024 * 1024);
      const durationMatches = durationFilter === "all" || (durationFilter === "short" && duration > 0 && duration < 60 * 1000) || (durationFilter === "medium" && duration >= 60 * 1000 && duration < 10 * 60 * 1000) || (durationFilter === "long" && duration >= 10 * 60 * 1000);
      return (!search || haystack.includes(search)) && (statusFilter === "all" || item.status === statusFilter) && sizeMatches && durationMatches;
    });
    return filtered.sort((left, right) => {
      const leftResult = left.result || {};
      const rightResult = right.result || {};
      if (sortBy === "oldest") return Number(left.updatedAt || left.createdAt || 0) - Number(right.updatedAt || right.createdAt || 0);
      if (sortBy === "name") return String(leftResult.filename || "").localeCompare(String(rightResult.filename || ""));
      if (sortBy === "size") return Number(rightResult.bytes || 0) - Number(leftResult.bytes || 0);
      if (sortBy === "duration") return Number(rightResult.durationMs || 0) - Number(leftResult.durationMs || 0);
      return Number(right.updatedAt || right.createdAt || 0) - Number(left.updatedAt || left.createdAt || 0);
    });
  }, [items, query, statusFilter, sizeFilter, durationFilter, sortBy]);

  const removeItem = async (item) => {
    const resultName = item.result?.filename || "this result";
    let downloadFolder = "";
    if (item.storage === "local") {
      if (!window.confirm(`Delete ${resultName} from this device?`)) return;
    } else {
      downloadFolder = window.prompt(`Enter the Downloads folder containing ${resultName}.\n\nExample: ~/Downloads`, "~/Downloads");
      if (downloadFolder === null) return;
      if (!downloadFolder.trim()) {
        setMessage("Enter the Downloads folder path before deleting this result.");
        return;
      }
      if (!window.confirm(`Delete ${resultName} from that Downloads folder and then remove it from server history?`)) return;
    }
    setDeletingId(item.id);
    setMessage("");
    try {
      if (item.storage === "local") {
        await deleteLocalHistory(item.id);
        setLocal((current) => ({ ...current, items: current.items.filter((entry) => entry.id !== item.id) }));
      } else {
        // The browser owns its Downloads folder. The authorized local agent must
        // delete the downloaded copy before the server history is removed.
        await deleteDownloadedFile(downloadFolder, resultName);
        await deleteServerHistory(item.id);
        setServer((current) => ({ ...current, items: current.items.filter((entry) => entry.id !== item.id) }));
      }
      setPreviewItem((current) => current?.id === item.id ? null : current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The saved result could not be deleted.");
    } finally {
      setDeletingId("");
    }
  };

  const localReady = local.status === "ready";
  const serverReady = server.status === "ready";

  const openResultsFolder = async () => {
    setOpeningResults(true);
    setMessage("");
    try {
      const value = await openLocalResultsFolder();
      setMessage(`Opened the Results folder${value.path ? `: ${value.path}` : "."}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The Results folder could not be opened.");
    } finally {
      setOpeningResults(false);
    }
  };

  const editItem = (item) => {
    const result = item.result || {};
    if (!result.downloadUrl) {
      setMessage("This saved result is no longer available for editing.");
      return;
    }
    rememberHistoryEdit({ tool, downloadUrl: result.downloadUrl, filename: result.filename, mime: result.mime });
    window.location.assign(tool === "pdf-editor" ? "/pdf-editor" : tool === "pdf-text-editor" ? "/pdf-text-editor" : tool === "pdf-compressor" ? "/pdf-compressor" : tool === "video-repair" ? "/video-repair" : "/image-converter");
  };

  return <section className="history-panel" aria-labelledby={`${tool}-history-title`}>
    <div className="history-panel-heading">
      <div><span className="section-kicker"><span className="kicker-line" /> Saved results</span><h2 id={`${tool}-history-title`}><Icon size={21} /> {toolNames[tool] || "Tool"} history</h2><p>Download or remove results kept by the Local agent or the server.</p></div>
      <div className="history-heading-actions">{localReady && <button className="secondary-button" type="button" onClick={openResultsFolder} disabled={openingResults}><FolderOpen size={16} /> {openingResults ? "Opening…" : "Open Results folder"}</button>}<button className="secondary-button" type="button" onClick={loadHistory} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={16} /> Refresh</button></div>
    </div>
    {loading && <div className="history-empty"><RefreshCw className="spin" size={24} /><strong>Loading history</strong><span>Checking saved results on this device and the server.</span></div>}
    {!loading && !localReady && !serverReady && <div className="history-empty"><AlertTriangle size={22} /><strong>History is unavailable</strong><span>{local.message || server.message || "Connect to the server or authorize the Local agent to view saved results."}</span><Link className="secondary-button" href="/local-agent">Open Local agent setup</Link></div>}
    {!loading && local.status !== "ready" && <div className="history-source-note"><strong>{local.status === "unsupported" ? "Local history unavailable" : "Local agent"}</strong><span>{local.message || "Pair the Local agent to view files saved on this device."}</span><Link href="/local-agent">Open setup</Link></div>}
    {!loading && server.status !== "ready" && <div className="history-source-note"><strong>Server history unavailable</strong><span>{server.message || "The server did not respond."}</span></div>}
    {!loading && (localReady || serverReady) && !items.length && <div className="history-empty"><Icon size={25} /><strong>No saved results yet</strong><span>Local results appear only when “Keep final result on this device” is selected. Server results remain available until they are deleted or cleaned up.</span></div>}
    {!loading && (localReady || serverReady) && items.length > 0 && <div className="history-filters" aria-label="History filters"><label>Search<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filename or location" /></label><label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="completed">Completed</option></select></label><label>File size<select value={sizeFilter} onChange={(event) => setSizeFilter(event.target.value)}><option value="all">Any size</option><option value="small">Under 1 MB</option><option value="medium">1–10 MB</option><option value="large">10 MB or more</option></select></label><label>Duration<select value={durationFilter} onChange={(event) => setDurationFilter(event.target.value)}><option value="all">Any duration</option><option value="short">Under 1 minute</option><option value="medium">1–10 minutes</option><option value="long">10 minutes or more</option></select></label><label>Sort<select value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name</option><option value="size">Largest file</option><option value="duration">Longest duration</option></select></label></div>}
    {!loading && (localReady || serverReady) && items.length > 0 && !filteredItems.length && <div className="history-empty history-filter-empty"><Icon size={25} /><strong>No matching results</strong><span>Change the search or filters to see saved results.</span></div>}
    {!loading && filteredItems.length > 0 && <div className="history-list">{filteredItems.map((item) => {
      const result = item.result || {};
      return <article className="history-item" key={`${item.storage}-${item.id}`}>
        <div className="history-item-icon"><Icon size={19} /></div>
        <div className="history-item-copy"><strong title={result.filename}>{result.filename || "Saved result"}</strong><span>{historyDate(item.updatedAt || item.createdAt)} · {formatBytes(result.bytes || 0)} · {item.storage === "local" ? "Local" : "Server"}</span><small><span className="history-status-badge">{item.status || "completed"}</span>{tool === "video-repair" && ` · Duration ${formatDuration(result.durationMs)}`} · {item.location || (item.storage === "local" ? "Local agent Results folder" : "Server temporary storage")}</small></div>
        <div className="history-item-actions"><button className="icon-button history-preview-button" type="button" onClick={() => setPreviewItem(item)} aria-label={`Preview ${result.filename || "saved result"}`} title="Preview"><Eye size={17} /></button><a className="secondary-button" href={result.downloadUrl} download={result.filename}><Download size={16} /> Download</a><button className="icon-button history-delete-button" type="button" onClick={() => removeItem(item)} disabled={deletingId === item.id} aria-label={item.storage === "local" ? `Delete ${result.filename || "saved result"} from this device` : `Delete ${result.filename || "saved result"} from Downloads and server history`} title={item.storage === "local" ? "Delete from device" : "Delete from Downloads and server history"}><Trash2 size={17} /></button></div>
      </article>;
    })}</div>}
    {!loading && <p className="history-note">Server Delete first asks the authorized Local agent to remove the named file from the Downloads folder, then removes the server copy and listing. If the file is missing or the agent is unavailable, the listing stays.</p>}
    {message && <DismissibleMessage className="error-banner" resetKey={message}><AlertTriangle size={17} /><span>{message}</span></DismissibleMessage>}
    {previewItem && <HistoryPreviewModal item={previewItem} onClose={() => setPreviewItem(null)} onDelete={() => removeItem(previewItem)} onEdit={() => editItem(previewItem)} deleting={deletingId === previewItem.id} />}
  </section>;
}

function previewUrlFor(result) {
  if (result?.previewUrl) return result.previewUrl;
  if (!result?.downloadUrl) return "";
  return `${result.downloadUrl}${result.downloadUrl.includes("?") ? "&" : "?"}preview=1`;
}

function HistoryPreviewModal({ item, onClose, onDelete, onEdit, deleting }) {
  const result = item.result || {};
  const previewUrl = previewUrlFor(result);
  const [previewError, setPreviewError] = useState(false);
  const tool = item.tool;

  useEffect(() => {
    const handleKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const handleDelete = () => {
    onDelete();
  };

  return <div className="history-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="history-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="history-preview-title">
      <div className="history-preview-header"><div><span>Saved result preview</span><strong id="history-preview-title" title={result.filename}>{result.filename || "Saved result"}</strong><small>{item.storage === "local" ? "Local agent result" : "Server result"} · {formatBytes(result.bytes || 0)}</small></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close preview" title="Close preview"><X size={20} /></button></div>
      <div className="history-preview-body">
        {!previewUrl && <DismissibleMessage className="preview-unavailable" resetKey="missing-preview"><AlertTriangle size={18} /><span>This saved result is no longer available for preview.</span></DismissibleMessage>}
        {previewUrl && tool === "image-converter" && (previewError ? <DismissibleMessage className="preview-unavailable" resetKey={`${result.filename}-image-preview`}><AlertTriangle size={18} /><span>This image cannot be previewed in this browser, but it can still be downloaded.</span></DismissibleMessage> : <img className="history-preview-image" src={previewUrl} alt={`Preview of ${result.filename || "saved image"}`} onError={() => setPreviewError(true)} />)}
        {previewUrl && tool === "video-repair" && (previewError ? <DismissibleMessage className="preview-unavailable" resetKey={`${result.filename}-video-preview`}><AlertTriangle size={18} /><span>This video cannot be previewed in this browser, but it can still be downloaded.</span></DismissibleMessage> : <video className="history-preview-video" controls autoPlay={false} preload="metadata" playsInline onError={() => setPreviewError(true)} aria-label={`Preview of ${result.filename || "saved video"}`}><source src={previewUrl} /></video>)}
        {(previewUrl && (tool === "pdf-editor" || tool === "pdf-text-editor" || tool === "pdf-compressor")) && <iframe className="history-preview-pdf" src={previewUrl} title={`Preview of ${result.filename || "saved PDF"}`} />}
      </div>
      <div className="history-preview-actions"><button className="secondary-button history-modal-delete" type="button" onClick={handleDelete} disabled={deleting}><Trash2 size={16} /> {deleting ? "Deleting…" : "Delete file"}</button><a className="primary-button" href={result.downloadUrl} download={result.filename}><Download size={17} /> Download</a>{tool !== "pdf-compressor" && <button className="secondary-button" type="button" onClick={onEdit}><Pencil size={16} /> Edit file</button>}</div>
    </div>
  </div>;
}
