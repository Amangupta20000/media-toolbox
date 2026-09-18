import { PDFDocument, degrees } from "pdf-lib";
import { normalizeImageRotation, rotatedImageDrawPlacement } from "./pdf-image-placement.js";

export const BROWSER_PDF_FIDELITY_WARNING = "Some pages were rasterized because their PDF structure could not be copied natively. Resolution or selectable text may be reduced. Use Local agent for full-fidelity export.";

function fileExtension(name) {
  const value = String(name || "").toLowerCase();
  return value.slice(value.lastIndexOf("."));
}

function bytesFor(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value || 0);
}

async function sourceBytesFor(record) {
  if (record?.sourceBytes) return bytesFor(record.sourceBytes).slice();
  if (record?.file?.arrayBuffer) return new Uint8Array(await record.file.arrayBuffer());
  throw new Error("The original PDF bytes are no longer available in this browser.");
}

async function imageBytesFor(image) {
  if (image?.bytes) return bytesFor(image.bytes).slice();
  if (image?.sourceBytes) return bytesFor(image.sourceBytes).slice();
  if (image?.file?.arrayBuffer) return new Uint8Array(await image.file.arrayBuffer());
  throw new Error("An inserted image is no longer available in this browser.");
}

function pageDimensions(page) {
  return {
    width: Math.max(1, Number(page?.width) || 595.28),
    height: Math.max(1, Number(page?.height) || 841.89),
  };
}

async function drawImages(pdf, outputPage, images, pageHeight) {
  for (const image of images || []) {
    const extension = image.extension || fileExtension(image.file?.name || image.name);
    if (![".png", ".jpg", ".jpeg"].includes(extension)) {
      throw new Error("Browser PDF mode supports PNG, JPG, and JPEG images.");
    }
    const bytes = await imageBytesFor(image);
    const embedded = extension === ".png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const placement = rotatedImageDrawPlacement(image, pageHeight);
    outputPage.drawImage(embedded, {
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      rotate: degrees(placement.rotation),
    });
  }
}

async function addNativePage(output, sourceDocument, page, preparedPage) {
  const sourcePage = sourceDocument
    ? (await output.copyPages(sourceDocument, [page.pageIndex]))[0]
    : null;
  const dimensions = pageDimensions(page);
  const outputPage = sourcePage ? output.addPage(sourcePage) : output.addPage([dimensions.width, dimensions.height]);
  try {
    if ([0, 90, 180, 270].includes(Number(page.rotation))) outputPage.setRotation(degrees(Number(page.rotation)));
    await drawImages(output, outputPage, preparedPage?.images, dimensions.height);
    return outputPage;
  } catch (error) {
    output.removePage(output.getPageCount() - 1);
    throw error;
  }
}

async function addRasterFallback(output, page, preparedPage, rasterizePage) {
  if (typeof rasterizePage !== "function") throw new Error("This PDF page could not be copied or rasterized in Browser mode.");
  const raster = await rasterizePage(page, preparedPage);
  if (!raster?.bytes?.byteLength) {
    const dimensions = pageDimensions(page);
    const outputPage = output.addPage([dimensions.width, dimensions.height]);
    if ([0, 90, 180, 270].includes(Number(page.rotation))) outputPage.setRotation(degrees(Number(page.rotation)));
    return outputPage;
  }
  const dimensions = pageDimensions(page);
  const outputPage = output.addPage([dimensions.width, dimensions.height]);
  const image = await output.embedJpg(bytesFor(raster.bytes));
  outputPage.drawImage(image, {
    x: 0,
    y: 0,
    width: dimensions.width,
    height: dimensions.height,
  });
  if ([0, 90, 180, 270].includes(Number(page.rotation))) outputPage.setRotation(degrees(Number(page.rotation)));
  return outputPage;
}

/**
 * Assemble a Browser PDF without rasterizing normal source pages. Source
 * pages are copied from their original PDF resources; only pages that cannot
 * be copied natively use the supplied raster fallback.
 */
export async function assembleBrowserPdf(pdfFiles, pages, preparedPages = [], { onProgress, rasterizePage } = {}) {
  if (!Array.isArray(pages) || !pages.length) throw new Error("Add at least one page before exporting.");
  const sourceDocuments = new Array(Array.isArray(pdfFiles) ? pdfFiles.length : 0).fill(null);
  const sourceFailures = new Set();
  for (const page of pages) {
    if (page?.kind !== "source" || sourceDocuments[page.pdfIndex] || sourceFailures.has(page.pdfIndex)) continue;
    try {
      sourceDocuments[page.pdfIndex] = await PDFDocument.load(await sourceBytesFor(pdfFiles[page.pdfIndex]), { updateMetadata: false, throwOnInvalidObject: false });
    } catch {
      sourceFailures.add(page.pdfIndex);
    }
  }

  const output = await PDFDocument.create();
  let nativePageCount = 0;
  let fallbackPageCount = 0;
  const fallbackPages = [];
  for (const [index, page] of pages.entries()) {
    const preparedPage = preparedPages[index] || {};
    onProgress?.(17 + Math.round((index / Math.max(1, pages.length)) * 44));
    const sourceDocument = page.kind === "source" ? sourceDocuments[page.pdfIndex] : null;
    let native = page.kind !== "source" || Boolean(sourceDocument);
    if (native) {
      try {
        await addNativePage(output, sourceDocument, page, preparedPage);
        nativePageCount += 1;
      } catch {
        native = false;
      }
    }
    if (!native) {
      await addRasterFallback(output, page, preparedPage, rasterizePage);
      fallbackPageCount += 1;
      fallbackPages.push(index + 1);
    }
    onProgress?.(20 + Math.round(((index + 1) / Math.max(1, pages.length)) * 44));
  }

  onProgress?.(64);
  const bytes = await output.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
  onProgress?.(72);
  const warnings = fallbackPageCount ? [BROWSER_PDF_FIDELITY_WARNING] : [];
  return {
    bytes,
    pageCount: pages.length,
    nativePageCount,
    fallbackPageCount,
    fallbackPages,
    warnings,
    method: fallbackPageCount ? "Browser PDF editor · native page copy with raster fallback" : "Browser PDF editor · native page copy",
  };
}
