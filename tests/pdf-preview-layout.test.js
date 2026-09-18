import assert from "node:assert/strict";
import test from "node:test";
import { buildPreviewOffsets, calculatePreviewPageLayout, estimatePreviewPageCardHeight, previewIndexAtOffset, previewViewportLimits } from "../lib/pdf-preview-layout.js";

test("preview layout fits each page orientation while preserving its aspect ratio", () => {
  const portrait = calculatePreviewPageLayout({ pageWidth: 595, pageHeight: 842, availableWidth: 700, maxPreviewHeight: 760, zoom: 1 });
  const landscape = calculatePreviewPageLayout({ pageWidth: 842, pageHeight: 595, availableWidth: 700, maxPreviewHeight: 760, zoom: 1 });
  const square = calculatePreviewPageLayout({ pageWidth: 600, pageHeight: 600, availableWidth: 700, maxPreviewHeight: 760, zoom: 1 });

  assert.equal(portrait.isZoomed, false);
  assert.equal(landscape.isZoomed, false);
  assert.equal(square.isZoomed, false);
  assert.ok(portrait.width <= 700 && portrait.height <= 760);
  assert.ok(landscape.width <= 700 && landscape.height <= 760);
  assert.ok(square.width <= 700 && square.height <= 760);
  assert.ok(Math.abs(portrait.width / portrait.height - 595 / 842) < 0.0001);
  assert.ok(Math.abs(landscape.width / landscape.height - 842 / 595) < 0.0001);
  assert.ok(estimatePreviewPageCardHeight({ pageWidth: 595, pageHeight: 842, availableWidth: 700, maxPreviewHeight: 760 }) !== estimatePreviewPageCardHeight({ pageWidth: 842, pageHeight: 595, availableWidth: 700, maxPreviewHeight: 760 }));
});

test("zoomed preview pages grow intentionally beyond fit bounds", () => {
  const layout = calculatePreviewPageLayout({ pageWidth: 595, pageHeight: 842, availableWidth: 700, maxPreviewHeight: 760, zoom: 1.5 });
  assert.equal(layout.isZoomed, true);
  assert.ok(layout.width > 700 || layout.height > 760);
  assert.ok(Math.abs(layout.width / layout.height - 595 / 842) < 0.0001);
});

test("variable preview offsets target the correct page after mixed page measurements", () => {
  const sizes = [400, 700, 250];
  const { offsets, totalSize } = buildPreviewOffsets(sizes, 17);
  assert.deepEqual(offsets, [0, 417, 1134]);
  assert.equal(totalSize, 1384);
  assert.equal(previewIndexAtOffset(0, offsets, sizes, 17), 0);
  assert.equal(previewIndexAtOffset(500, offsets, sizes, 17), 1);
  assert.equal(previewIndexAtOffset(1200, offsets, sizes, 17), 2);
});

test("viewport limits provide mobile and desktop page caps", () => {
  assert.deepEqual(previewViewportLimits({ viewportWidth: 390, viewportHeight: 800 }), { mobile: true, maxPreviewHeight: 520 });
  assert.deepEqual(previewViewportLimits({ viewportWidth: 1440, viewportHeight: 1200 }), { mobile: false, maxPreviewHeight: 760 });
});
