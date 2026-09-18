import assert from "node:assert/strict";
import test from "node:test";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { assembleBrowserPdf, BROWSER_PDF_FIDELITY_WARNING } from "../lib/pdf-browser-editor.js";
import { extractPdfTextRuns } from "../lib/pdf-text-editor.js";
import { createPdfTextPreview } from "../lib/pdf-text-preview.js";

const samplePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function createHighResolutionFixture() {
  const sharp = (await import("sharp")).default;
  const pixels = Buffer.alloc(2400 * 1600 * 3, 180);
  const jpeg = await sharp(pixels, { raw: { width: 2400, height: 1600, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const image = await document.embedJpg(jpeg);
  for (let index = 0; index < 4; index += 1) {
    const page = document.addPage([600, 400]);
    page.drawImage(image, { x: 0, y: 0, width: 600, height: 400 });
    page.drawText(`Source page ${index + 1}`, { x: 20, y: 20, font, size: 18, color: rgb(0.1, 0.2, 0.3) });
  }
  return { bytes: await document.save({ useObjectStreams: false }), jpegBytes: jpeg, jpegDimensions: [2400, 1600] };
}

function pageImageInfo(document, page) {
  const resources = page.node.Resources();
  const xObjects = resources?.lookupMaybe(PDFName.XObject, PDFDict);
  for (const [, reference] of xObjects?.entries() || []) {
    const stream = document.context.lookup(reference);
    if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
    return {
      width: stream.dict.get(PDFName.of("Width"))?.asNumber?.(),
      height: stream.dict.get(PDFName.of("Height"))?.asNumber?.(),
      filter: stream.dict.get(PDFName.of("Filter"))?.toString(),
      length: stream.contents.length,
    };
  }
  return null;
}

async function searchableText(bytes) {
  const pdf = await getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
  const text = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ disableCombineTextItems: true });
    text.push(content.items.map((item) => item.str).join(" "));
  }
  return text;
}

test("Browser PDF editor copies normal source pages without downsampling them", async () => {
  const fixture = await createHighResolutionFixture();
  const pages = [
    { kind: "source", pdfIndex: 0, pageIndex: 0, width: 600, height: 400, rotation: 0 },
    { kind: "source", pdfIndex: 0, pageIndex: 2, width: 600, height: 400, rotation: 90 },
    { kind: "source", pdfIndex: 0, pageIndex: 3, width: 600, height: 400, rotation: 0 },
  ];
  const assembled = await assembleBrowserPdf(
    [{ name: "high-resolution-source.pdf", sourceBytes: fixture.bytes }],
    pages,
    [{ images: [] }, { images: [] }, { images: [] }],
  );
  const output = await PDFDocument.load(assembled.bytes);
  assert.equal(output.getPageCount(), 3);
  assert.equal(assembled.nativePageCount, 3);
  assert.equal(assembled.fallbackPageCount, 0);
  assert.deepEqual(assembled.warnings, []);
  assert.deepEqual(output.getPages().map((page) => page.getRotation().angle), [0, 90, 0]);
  for (const page of output.getPages()) assert.deepEqual(pageImageInfo(output, page), { width: fixture.jpegDimensions[0], height: fixture.jpegDimensions[1], filter: "/DCTDecode", length: fixture.jpegBytes.length });
  const text = await searchableText(assembled.bytes);
  assert.match(text[0], /Source page 1/);
  assert.match(text[1], /Source page 3/);
  assert.match(text[2], /Source page 4/);
});

test("Browser PDF editor keeps native pages while adding blank pages and image overlays", async () => {
  const fixture = await createHighResolutionFixture();
  const pages = [
    { kind: "source", pdfIndex: 0, pageIndex: 0, width: 600, height: 400, rotation: 0 },
    { kind: "blank", width: 300, height: 200, rotation: 0 },
  ];
  const assembled = await assembleBrowserPdf(
    [{ name: "source.pdf", sourceBytes: fixture.bytes }],
    pages,
    [
      { images: [] },
      { images: [{ extension: ".png", bytes: samplePng, x: 20, y: 30, width: 40, height: 40, rotation: 0 }] },
    ],
  );
  const output = await PDFDocument.load(assembled.bytes);
  assert.equal(assembled.nativePageCount, 2);
  assert.equal(assembled.fallbackPageCount, 0);
  assert.deepEqual(output.getPages().map((page) => [page.getWidth(), page.getHeight()]), [[600, 400], [300, 200]]);
  assert.deepEqual(pageImageInfo(output, output.getPages()[0]), { width: 2400, height: 1600, filter: "/DCTDecode", length: fixture.jpegBytes.length });
  assert.ok(pageImageInfo(output, output.getPages()[1]), "the inserted image should be embedded on the blank page");
});

test("Browser PDF editor reports reduced-fidelity fallback only when native copying fails", async () => {
  const sharp = (await import("sharp")).default;
  const fallbackJpeg = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "white" } }).jpeg({ quality: 92 }).toBuffer();
  const assembled = await assembleBrowserPdf(
    [{ name: "unsupported.pdf", sourceBytes: Buffer.from("not a PDF") }],
    [{ kind: "source", pdfIndex: 0, pageIndex: 0, width: 600, height: 400, rotation: 0 }],
    [{ images: [] }],
    { rasterizePage: async () => ({ bytes: fallbackJpeg }) },
  );
  assert.equal(assembled.nativePageCount, 0);
  assert.equal(assembled.fallbackPageCount, 1);
  assert.deepEqual(assembled.fallbackPages, [1]);
  assert.deepEqual(assembled.warnings, [BROWSER_PDF_FIDELITY_WARNING]);
  assert.match(assembled.method, /raster fallback/);
});

test("Browser PDF text replacement keeps high-resolution page artwork", async () => {
  const fixture = await createHighResolutionFixture();
  const extracted = await extractPdfTextRuns(fixture.bytes);
  const run = extracted.pages[0].runs.find((item) => item.text === "Source page 1");
  assert.ok(run, "the fixture should expose selectable text");
  const output = await createPdfTextPreview(fixture.bytes, [{ pageIndex: run.pageIndex, operatorOrdinal: run.ordinal, replacementText: "Edited page 1", mode: "native" }]);
  const outputDocument = await PDFDocument.load(output);
  assert.deepEqual(pageImageInfo(outputDocument, outputDocument.getPages()[0]), { width: fixture.jpegDimensions[0], height: fixture.jpegDimensions[1], filter: "/DCTDecode", length: fixture.jpegBytes.length });
  assert.match((await searchableText(output))[0], /Edited page 1/);
});
