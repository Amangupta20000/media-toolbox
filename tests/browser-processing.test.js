import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_IMAGE_MAX_BYTES, BROWSER_PDF_MAX_BYTES, browserOutputMime, browserSupportsFormat, browserSupportsTool } from "../components/browser-processing.js";

test("browser image conversion uses a conservative 5 MB per-image limit", () => {
  assert.equal(BROWSER_IMAGE_MAX_BYTES, 5 * 1024 * 1024);
});

test("browser processing is limited to supported quick tools", () => {
  assert.equal(browserSupportsTool("image-converter"), true);
  assert.equal(browserSupportsTool("svg-to-png"), true);
  assert.equal(browserSupportsTool("pdf-compressor"), true);
  assert.equal(browserSupportsTool("pdf-editor"), false);
  assert.equal(browserSupportsTool("video-repair"), false);
});

test("browser PDF compression uses a conservative 10 MB input limit", () => {
  assert.equal(BROWSER_PDF_MAX_BYTES, 10 * 1024 * 1024);
});

test("browser image output exposes only browser-safe formats", () => {
  assert.equal(browserOutputMime("png"), "image/png");
  assert.equal(browserOutputMime("jpeg"), "image/jpeg");
  assert.equal(browserSupportsFormat("original"), true);
  assert.equal(browserSupportsFormat("png", { png: true }), true);
  assert.equal(browserSupportsFormat("jpeg", { jpeg: false }), false);
  assert.equal(browserSupportsFormat("heic", { heic: false }), false);
});
