import { Download } from "lucide-react";
import { downloadUrlWithFilename } from "./result-filename.jsx";

export function ResultDownloadNote({ result, mode = "local", keepResult = false, filename, onDownload, downloading = false }) {
  if (!result?.downloadUrl) return null;

  const downloadName = filename || result.filename;
  const downloadUrl = downloadUrlWithFilename(result.downloadUrl, downloadName);
  const downloadControl = onDownload
    ? <button className="result-download-note-link" type="button" onClick={onDownload} disabled={downloading}>{downloading ? "Preparing download…" : "Download again"}</button>
    : <a className="result-download-note-link" href={downloadUrl} download={downloadName}>Download again</a>;

  const retainedLocalResult = mode === "local" && (keepResult || result.retained);
  if (mode === "browser") {
    return <div className="result-download-note">
      <div className="result-download-note-copy">
        <Download size={16} aria-hidden="true" />
        <span>This result is kept temporarily in this browser tab. Download it before closing or refreshing the tab.</span>
      </div>
      {downloadControl}
    </div>;
  }
  const location = result.location || (
    retainedLocalResult
      ? "the Local agent Results folder"
      : mode === "local"
        ? "temporary Local agent storage"
        : "temporary processing storage"
  );

  const message = retainedLocalResult
    ? <>This file is already saved to <code>{location}</code>. To download it again, click here.</>
    : mode === "local"
      ? <>This file is ready in <code>{location}</code>. Download it now; it is cleaned up after download.</>
      : <>This file is saved to <code>{location}</code>. To download it again, click here.</>;

  return <div className="result-download-note">
    <div className="result-download-note-copy">
      <Download size={16} aria-hidden="true" />
      <span>{message}</span>
    </div>
    {downloadControl}
  </div>;
}
