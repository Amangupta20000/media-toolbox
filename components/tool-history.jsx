"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, Download, Eye, FileText, Film, Image as ImageIcon, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { formatBytes } from "./file-dropzone.jsx";
import { rememberHistoryEdit } from "./history-edit.js";
import { deleteDownloadedFile, deleteLocalHistory, deleteServerHistory, getLocalHistory, getServerHistory, probeLocalAgent, probeServer } from "./processing-client.js";

const toolNames = {
  "image-converter": "Image conversion",
  "video-repair": "Video repair",
  "pdf-editor": "PDF editing",
};

const toolIcons = {
  "image-converter": ImageIcon,
  "video-repair": Film,
  "pdf-editor": FileText,
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

async function loadLocalHistory(tool) {
  try {
    const agent = await probeLocalAgent();
    if (!agent.connected) return { status: "unavailable", items: [], message: agent.error || "Admin login or activation is required in the Local agent dashboard." };
    try {
      const payload = await getLocalHistory(tool);
      return { status: "ready", items: Array.isArray(payload.items) ? payload.items : [], message: "" };
    } catch (error) {
      if (error?.status === 404) {
        return { status: "unsupported", items: [], message: "The Local agent is connected, but this installed version does not support History. Update the agent application to the latest release." };
      }
      if (error?.status === 401 || error?.status === 403) {
        return { status: "unavailable", items: [], message: "The Local agent is running, but this browser is not authorized. Open the Local agent dashboard." };
      }
      return { status: "error", items: [], message: error instanceof Error ? error.message : "Local history could not be loaded." };
    }
  } catch (error) {
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
  ].sort((left, right) => Number(right.updatedAt || right.createdAt || 0) - Number(left.updatedAt || left.createdAt || 0));

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

  const editItem = (item) => {
    const result = item.result || {};
    if (!result.downloadUrl) {
      setMessage("This saved result is no longer available for editing.");
      return;
    }
    rememberHistoryEdit({ tool, downloadUrl: result.downloadUrl, filename: result.filename, mime: result.mime });
    window.location.assign(tool === "pdf-editor" ? "/pdf-editor" : tool === "video-repair" ? "/video-repair" : "/image-converter");
  };

  return <section className="history-panel" aria-labelledby={`${tool}-history-title`}>
    <div className="history-panel-heading">
      <div><span className="section-kicker"><span className="kicker-line" /> Saved results</span><h2 id={`${tool}-history-title`}><Icon size={21} /> {toolNames[tool] || "Tool"} history</h2><p>Download or remove results kept by the Local agent or the server.</p></div>
      <button className="secondary-button" type="button" onClick={loadHistory} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={16} /> Refresh</button>
    </div>
    {loading && <div className="history-empty"><RefreshCw className="spin" size={24} /><strong>Loading history</strong><span>Checking saved results on this device and the server.</span></div>}
    {!loading && !localReady && !serverReady && <div className="history-empty"><AlertTriangle size={22} /><strong>History is unavailable</strong><span>{local.message || server.message || "Connect to the server or authorize the Local agent to view saved results."}</span><Link className="secondary-button" href="/local-agent">Open Local agent setup</Link></div>}
    {!loading && local.status !== "ready" && <div className="history-source-note"><strong>{local.status === "unsupported" ? "Local history unavailable" : "Local agent"}</strong><span>{local.message || "Pair the Local agent to view files saved on this device."}</span><Link href="/local-agent">Open setup</Link></div>}
    {!loading && server.status !== "ready" && <div className="history-source-note"><strong>Server history unavailable</strong><span>{server.message || "The server did not respond."}</span></div>}
    {!loading && (localReady || serverReady) && !items.length && <div className="history-empty"><Icon size={25} /><strong>No saved results yet</strong><span>Local results appear only when “Keep final result on this device” is selected. Server results remain available until they are deleted or cleaned up.</span></div>}
    {!loading && items.length > 0 && <div className="history-list">{items.map((item) => {
      const result = item.result || {};
      return <article className="history-item" key={`${item.storage}-${item.id}`}>
        <div className="history-item-icon"><Icon size={19} /></div>
        <div className="history-item-copy"><strong title={result.filename}>{result.filename || "Saved result"}</strong><span>{historyDate(item.updatedAt || item.createdAt)} · {formatBytes(result.bytes || 0)}</span><small>{item.location || (item.storage === "local" ? "Local agent Results folder" : "Server temporary storage")}</small></div>
        <div className="history-item-actions"><button className="icon-button history-preview-button" type="button" onClick={() => setPreviewItem(item)} aria-label={`Preview ${result.filename || "saved result"}`} title="Preview"><Eye size={17} /></button><a className="secondary-button" href={result.downloadUrl} download={result.filename}><Download size={16} /> Download</a><button className="icon-button history-delete-button" type="button" onClick={() => removeItem(item)} disabled={deletingId === item.id} aria-label={item.storage === "local" ? `Delete ${result.filename || "saved result"} from this device` : `Delete ${result.filename || "saved result"} from Downloads and server history`} title={item.storage === "local" ? "Delete from device" : "Delete from Downloads and server history"}><Trash2 size={17} /></button></div>
      </article>;
    })}</div>}
    {!loading && <p className="history-note">Server Delete first asks the authorized Local agent to remove the named file from the Downloads folder, then removes the server copy and listing. If the file is missing or the agent is unavailable, the listing stays.</p>}
    {message && <div className="error-banner"><AlertTriangle size={17} /><span>{message}</span></div>}
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
        {!previewUrl && <div className="preview-unavailable"><AlertTriangle size={18} /><span>This saved result is no longer available for preview.</span></div>}
        {previewUrl && tool === "image-converter" && (previewError ? <div className="preview-unavailable"><AlertTriangle size={18} /><span>This image cannot be previewed in this browser, but it can still be downloaded.</span></div> : <img className="history-preview-image" src={previewUrl} alt={`Preview of ${result.filename || "saved image"}`} onError={() => setPreviewError(true)} />)}
        {previewUrl && tool === "video-repair" && (previewError ? <div className="preview-unavailable"><AlertTriangle size={18} /><span>This video cannot be previewed in this browser, but it can still be downloaded.</span></div> : <video className="history-preview-video" controls autoPlay={false} preload="metadata" playsInline onError={() => setPreviewError(true)} aria-label={`Preview of ${result.filename || "saved video"}`}><source src={previewUrl} /></video>)}
        {previewUrl && tool === "pdf-editor" && <iframe className="history-preview-pdf" src={previewUrl} title={`Preview of ${result.filename || "saved PDF"}`} />}
      </div>
      <div className="history-preview-actions"><button className="secondary-button history-modal-delete" type="button" onClick={handleDelete} disabled={deleting}><Trash2 size={16} /> {deleting ? "Deleting…" : "Delete file"}</button><a className="primary-button" href={result.downloadUrl} download={result.filename}><Download size={17} /> Download</a><button className="secondary-button" type="button" onClick={onEdit}><Pencil size={16} /> Edit file</button></div>
    </div>
  </div>;
}
