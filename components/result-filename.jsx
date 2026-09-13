export function filenameExtension(filename) {
  const match = String(filename || "").match(/\.[a-z0-9]{1,8}$/i);
  return match ? match[0].toLowerCase() : "";
}

export function filenameStem(filename) {
  const value = String(filename || "download");
  const extension = filenameExtension(value);
  return extension ? value.slice(0, -extension.length) : value;
}

export function normalizeFilenameStem(value, fallbackFilename = "download") {
  const fallback = filenameStem(fallbackFilename).trim() || "download";
  const normalized = String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "")
    .slice(0, 180)
    .trim();
  return normalized || fallback;
}

export function downloadFilename(stem, originalFilename) {
  return `${normalizeFilenameStem(stem, originalFilename)}${filenameExtension(originalFilename)}`;
}

export function downloadUrlWithFilename(url, filename) {
  if (!url || !filename || /^(blob:|data:)/i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}filename=${encodeURIComponent(filename)}`;
}

export function ResultFilenameField({ originalFilename, value, onChange, label = "Download file name", description = "Choose the name to use when downloading this result." }) {
  const extension = filenameExtension(originalFilename);
  return <label className="result-filename-field">
    <span>{label}</span>
    <div className="result-filename-input-wrap">
      <input value={value} onChange={(event) => onChange(event.target.value)} aria-label={label} />
      {extension && <strong>{extension}</strong>}
    </div>
    <small>{description}</small>
  </label>;
}
