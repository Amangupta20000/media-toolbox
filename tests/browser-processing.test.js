import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_IMAGE_MAX_BYTES, BROWSER_IMAGE_TARGET_TOLERANCE_BYTES, BROWSER_PDF_EDITOR_IMAGE_MAX_BYTES, BROWSER_PDF_EDITOR_MAX_TOTAL_BYTES, BROWSER_PDF_MAX_BYTES, BROWSER_PDF_TEXT_EDITOR_MAX_BYTES, BROWSER_PDF_TEXT_EDITOR_MAX_PAGES, browserOutputMime, browserPdfPageNeedsRaster, browserSupportsFormat, browserSupportsTool, padJpegToTarget, processBrowserPdfTextEdits } from "../components/browser-processing.js";

test("browser image conversion uses a conservative 5 MB per-image limit", () => {
  assert.equal(BROWSER_IMAGE_MAX_BYTES, 5 * 1024 * 1024);
});

test("browser JPG target sizing can increase a smaller encoded result", async () => {
  const source = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0xff, 0xd9])], { type: "image/jpeg" });
  const target = 50 * 1000;
  const result = await padJpegToTarget(source, target);
  assert.ok(result.size >= target);
  assert.ok(result.size - target <= BROWSER_IMAGE_TARGET_TOLERANCE_BYTES);
  assert.equal(result.type, "image/jpeg");
});

test("browser processing includes lightweight PDF editors", () => {
  assert.equal(browserSupportsTool("image-converter"), true);
  assert.equal(browserSupportsTool("svg-to-png"), true);
  assert.equal(browserSupportsTool("pdf-compressor"), true);
  assert.equal(browserSupportsTool("pdf-editor"), true);
  assert.equal(browserSupportsTool("pdf-text-editor"), true);
  assert.equal(browserSupportsTool("video-repair"), false);
});

test("browser PDF text editor uses a 25 MB and 100-page limit", () => {
  assert.equal(BROWSER_PDF_TEXT_EDITOR_MAX_BYTES, 25 * 1024 * 1024);
  assert.equal(BROWSER_PDF_TEXT_EDITOR_MAX_PAGES, 100);
});

test("browser PDF text export rejects formatting and placement payloads", async () => {
  const source = { size: 1, name: "source.pdf" };
  await assert.rejects(() => processBrowserPdfTextEdits(source, [{ replacementText: "changed", format: { bold: true } }]), /Local-agent-only text styling or placement changes/);
  await assert.rejects(() => processBrowserPdfTextEdits(source, [{ replacementText: "changed", rotation: 15 }]), /Local-agent-only text styling or placement changes/);
});

test("browser PDF editor uses a conservative 1 MB image limit", () => {
  assert.equal(BROWSER_PDF_EDITOR_IMAGE_MAX_BYTES, 1 * 1024 * 1024);
});

test("browser PDF editor uses a conservative 50 MB total PDF limit", () => {
  assert.equal(BROWSER_PDF_EDITOR_MAX_TOTAL_BYTES, 50 * 1024 * 1024);
});

test("browser PDF compression uses a conservative 10 MB input limit", () => {
  assert.equal(BROWSER_PDF_MAX_BYTES, 10 * 1024 * 1024);
});

test("smallest browser PDF compression includes every page with image content", () => {
  const smallImagePage = { count: 1, largestPixels: 120 * 80, totalPixels: 120 * 80 };
  assert.equal(browserPdfPageNeedsRaster(smallImagePage, true, "small"), true);
  assert.equal(browserPdfPageNeedsRaster(smallImagePage, true, "balanced"), false);
  assert.equal(browserPdfPageNeedsRaster({ count: 0, largestPixels: 0, totalPixels: 0 }, true, "small"), false);
});

test("browser image output exposes only browser-safe formats", () => {
  assert.equal(browserOutputMime("png"), "image/png");
  assert.equal(browserOutputMime("jpeg"), "image/jpeg");
  assert.equal(browserSupportsFormat("original"), true);
  assert.equal(browserSupportsFormat("png", { png: true }), true);
  assert.equal(browserSupportsFormat("jpeg", { jpeg: false }), false);
  assert.equal(browserSupportsFormat("heic", { heic: false }), false);
});
