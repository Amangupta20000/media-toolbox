"use client";

import { useRef, useState } from "react";
import { FileImage, FileVideo, UploadCloud, X } from "lucide-react";

export function FileDropzone({ file, onFile, onClear, accept, label, hint, variant = "image", disabled = false }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const Icon = variant === "image" ? FileImage : FileVideo;
  const choose = (candidate) => { if (candidate && !disabled) onFile(candidate); };
  return <div
    className={`dropzone ${dragging ? "dragging" : ""} ${file ? "has-file" : ""} ${disabled ? "disabled" : ""}`}
    onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
    onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
    onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]); }}
    onClick={() => !disabled && inputRef.current?.click()}
    role="button" tabIndex={disabled ? -1 : 0}
    onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !disabled) inputRef.current?.click(); }}
  >
    <input ref={inputRef} type="file" accept={accept} hidden onChange={(event) => choose(event.target.files?.[0])} />
    {file ? <div className="selected-file" onClick={(event) => event.stopPropagation()}>
      <div className="file-symbol"><Icon size={21} /></div>
      <div className="selected-file-copy"><strong>{file.name}</strong><span>{formatBytes(file.size)} · ready to process</span></div>
      <button className="clear-file" aria-label={`Remove ${file.name}`} onClick={onClear}><X size={17} /></button>
    </div> : <div className="dropzone-empty">
      <div className="upload-symbol"><UploadCloud size={24} /></div>
      <div><strong>{label}</strong><span>{hint}</span></div>
      <span className="browse-chip">Browse files</span>
    </div>}
  </div>;
}

export function formatBytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1);
  return `${(value / 1000 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
