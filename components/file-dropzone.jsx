"use client";

import { useRef, useState } from "react";
import { FileImage, FileText, FileVideo, UploadCloud, X } from "lucide-react";

export function FileDropzone({ file, files, onFile, onFiles, onClear, onRemoveFile, accept, label, hint, variant = "image", disabled = false, required = false, multiple = false }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const Icon = variant === "image" ? FileImage : variant === "pdf" ? FileText : FileVideo;
  const selectedFiles = Array.isArray(files) ? files : file ? [file] : [];
  const choose = (candidate) => {
    if (disabled || !candidate) return;
    if (multiple) onFiles?.(Array.from(candidate));
    else onFile?.(candidate);
  };
  return <div
    className={`dropzone ${dragging ? "dragging" : ""} ${selectedFiles.length ? "has-file" : ""} ${disabled ? "disabled" : ""}`}
    onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
    onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
    onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); choose(multiple ? event.dataTransfer.files : event.dataTransfer.files[0]); }}
    onClick={() => !disabled && inputRef.current?.click()}
    role="button" tabIndex={disabled ? -1 : 0}
    onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !disabled) inputRef.current?.click(); }}
  >
    <input ref={inputRef} type="file" accept={accept} multiple={multiple} required={required && !selectedFiles.length} aria-required={required} hidden onChange={(event) => { choose(multiple ? event.target.files : event.target.files?.[0]); event.target.value = ""; }} />
    {selectedFiles.length ? <div className="selected-file-list" onClick={(event) => event.stopPropagation()}>
      {selectedFiles.map((selectedFile, index) => <div className="selected-file" key={`${selectedFile.name}-${selectedFile.size}-${selectedFile.lastModified || index}`}>
        <div className="file-symbol"><Icon size={21} /></div>
        <div className="selected-file-copy"><strong title={selectedFile.name}>{selectedFile.name}</strong><span>{formatBytes(selectedFile.size)} · ready to process</span></div>
        <button className="clear-file" aria-label={`Remove ${selectedFile.name}`} onClick={() => multiple ? onRemoveFile?.(index) : onClear?.()}><X size={17} /></button>
      </div>)}
      {multiple && <span className="dropzone-add-more" role="button" tabIndex={0} onClick={() => !disabled && inputRef.current?.click()} onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !disabled) inputRef.current?.click(); }}>Drop more or click to add files</span>}
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
