import { Download } from "lucide-react";

export function ResultDownloadNote({ result, mode = "server", keepResult = false }) {
  if (!result?.downloadUrl) return null;

  const retainedLocalResult = mode === "local" && (keepResult || result.retained);
  const location = result.location || (
    retainedLocalResult
      ? "the Local agent Results folder"
      : mode === "local"
        ? "temporary Local agent storage"
        : mode === "server"
          ? "temporary server storage"
          : "this browser"
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
    <a className="result-download-note-link" href={result.downloadUrl} download={result.filename}>
      Download again
    </a>
  </div>;
}
