"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { DismissibleMessage } from "./dismissible-message.jsx";

async function loadPdfLibrary() {
  const library = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (library.GlobalWorkerOptions) library.GlobalWorkerOptions.workerSrc = "/api/pdf/worker";
  return library;
}

function previewPdfUrl(result) {
  const previewUrl = result?.previewUrl || result?.downloadUrl;
  if (!previewUrl) return "";
  if (/^(blob:|data:)/i.test(previewUrl)) return previewUrl;
  return `${previewUrl}${previewUrl.includes("?") ? "&" : "?"}preview=1`;
}

export function PdfResultPreview({ result, title = "PDF preview", subtitle = "Scroll to review all pages", maxPages = null }) {
  const [pages, setPages] = useState([]);
  const [totalPages, setTotalPages] = useState(result?.pageCount || 0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setPages([]);
    setTotalPages(result?.pageCount || 0);
    setLoading(true);
    setError("");

    const loadPreview = async () => {
      try {
        const sourceUrl = previewPdfUrl(result);
        if (!sourceUrl) throw new Error("The generated PDF preview URL is unavailable.");
        const response = await fetch(sourceUrl, { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          let detail = "The generated PDF could not be loaded for preview.";
          try {
            const payload = await response.json();
            if (payload?.error) detail = payload.error;
          } catch { /* The response may be a non-JSON error page. */ }
          throw new Error(detail);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        const pdfLibrary = await loadPdfLibrary();
        const documentProxy = await pdfLibrary.getDocument({ data }).promise;
        if (!active) return;
        setTotalPages(documentProxy.numPages);
        const requestedMaxPages = Number(maxPages);
        const pageLimit = Number.isFinite(requestedMaxPages) && requestedMaxPages > 0
          ? Math.min(documentProxy.numPages, Math.floor(requestedMaxPages))
          : documentProxy.numPages;

        for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
          const pdfPage = await documentProxy.getPage(pageNumber);
          const baseViewport = pdfPage.getViewport({ scale: 1 });
          const scale = Math.min(1, 860 / baseViewport.width);
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          const canvas = document.createElement("canvas");
          const viewport = pdfPage.getViewport({ scale: scale * pixelRatio });
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("This browser could not create a PDF preview canvas.");
          await pdfPage.render({ canvasContext: context, viewport }).promise;
          const source = canvas.toDataURL("image/jpeg", 0.82);
          if (!active) return;
          setPages((current) => [...current, { pageNumber, source }]);
        }
        if (active) setLoading(false);
      } catch (previewError) {
        if (!active || previewError?.name === "AbortError") return;
        setError(previewError instanceof Error ? previewError.message : "The generated PDF preview could not be rendered.");
        setLoading(false);
      }
    };

    loadPreview();
    return () => {
      active = false;
      controller.abort();
    };
  }, [maxPages, result?.downloadUrl, result?.previewUrl, result?.pageCount]);

  const showingAllPages = totalPages > 0 && pages.length >= totalPages;
  return <div className="pdf-result-preview">
    <div className="preview-heading"><span>{title}</span><small>{subtitle}</small></div>
    <div className="pdf-result-preview-scroll" aria-label={`Preview of ${totalPages || 0} output pages`}>
      {pages.map(({ pageNumber, source }) => <figure className="pdf-result-page" key={pageNumber}>
        <img src={source} alt={`Preview of page ${pageNumber} of ${result.filename}`} />
        <figcaption>Page {pageNumber}</figcaption>
      </figure>)}
      {loading && <div className="pdf-preview-progress"><LoaderCircle className="spin" size={18} /><span>Rendering page {Math.min(pages.length + 1, totalPages || pages.length + 1)} of {totalPages || "…"}</span></div>}
      {!loading && error && <DismissibleMessage className="preview-unavailable" resetKey={error}><AlertTriangle size={18} /><span>{error} Download the PDF to view it.</span></DismissibleMessage>}
      {!loading && !error && pages.length === 0 && <DismissibleMessage className="preview-unavailable" resetKey="no-preview-pages"><AlertTriangle size={18} /><span>No pages were available for preview. The PDF is ready to download.</span></DismissibleMessage>}
      {!loading && !error && !showingAllPages && pages.length > 0 && <p className="pdf-preview-more">Showing the first {pages.length} of {totalPages} pages. Download the PDF to view the complete document.</p>}
      {error && pages.length > 0 && <DismissibleMessage className="pdf-preview-error" resetKey={`${error}-${pages.length}`}><AlertTriangle size={16} /><span>Preview rendering stopped after {pages.length} of {totalPages} pages. The complete PDF is ready to download.</span></DismissibleMessage>}
    </div>
  </div>;
}
