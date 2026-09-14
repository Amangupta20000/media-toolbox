import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { applyPdfOcrEdits, mergeCurrencyWords, recognizePdfText, sha256Hex, wordsFromBlocks } from "../lib/pdf-ocr.js";
import { applyRasterTextEdits } from "../lib/pdf-ocr-raster.js";

async function rasterPdf(pageCount = 1) {
  const canvas = createCanvas(1200, 360);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#102a43";
  context.font = "700 116px sans-serif";
  context.fillText("OCR TEST", 80, 170);
  context.font = "700 58px sans-serif";
  context.fillText("Bold English text", 80, 270);
  const document = await PDFDocument.create();
  const image = await document.embedPng(canvas.toBuffer("image/png"));
  for (let index = 0; index < pageCount; index += 1) {
    const page = document.addPage([600, 180]);
    page.drawImage(image, { x: 0, y: 0, width: 600, height: 180 });
  }
  return document.save({ useObjectStreams: false });
}

async function yellowSlidePdf() {
  const canvas = createCanvas(1600, 900);
  const context = canvas.getContext("2d");
  context.fillStyle = "#101820";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f5ef22";
  context.font = "700 116px sans-serif";
  context.fillText("Lecture Number", 480, 720);
  const document = await PDFDocument.create();
  const page = document.addPage([800, 450]);
  const image = await document.embedPng(canvas.toBuffer("image/png"));
  page.drawImage(image, { x: 0, y: 0, width: 800, height: 450 });
  return document.save({ useObjectStreams: false });
}

test("OCR detects image-only PDF text and exports a verified visual edit", async () => {
  const source = await rasterPdf();
  const snapshot = Buffer.from(source);
  const progressEvents = [];
  const detected = await recognizePdfText(source, { onProgress: (event) => progressEvents.push(event) });
  assert.equal(detected.pageCount, 1);
  assert.ok(detected.totalRuns >= 2);
  assert.ok(progressEvents.some((event) => event.status === "page" && event.progress === 100), "OCR should report completion for the page");
  assert.ok(progressEvents.some((event) => Number(event.progress) > 1 && Number(event.progress) < 100), "OCR should report intermediate progress");
  const progressValues = progressEvents.map((event) => Number(event.progress)).filter(Number.isFinite);
  assert.ok(progressValues.every((value, index) => index === 0 || value >= progressValues[index - 1]), "OCR progress should never move backward when Tesseract changes phase");
  const run = detected.pages[0].runs.find((item) => /OCR/i.test(item.text));
  assert.ok(run, "the OCR engine should detect the large English heading");
  assert.match(run.text, /OCR/);
  assert.equal(run.mode, "ocr");
  assert.deepEqual(Buffer.from(source), snapshot);

  const edited = await applyPdfOcrEdits(source, [{
    pageIndex: run.pageIndex,
    runId: run.runId,
    originalText: run.originalText,
    originalTextHash: run.originalTextHash,
    replacementText: "EDITED",
    mode: "ocr",
    bbox: run.bbox,
    confidence: run.confidence,
  }], { sourceHash: sha256Hex(source) });
  const output = await PDFDocument.load(edited.bytes);
  assert.equal(output.getPageCount(), 1);
  assert.ok(edited.warnings.some((warning) => /OCR edits reconstruct/i.test(warning)));
  assert.notEqual(crypto.createHash("sha256").update(edited.bytes).digest("hex"), sha256Hex(source));
});

test("OCR can scan only the pages identified as visually text-bearing", async () => {
  const source = await rasterPdf(2);
  const detected = await recognizePdfText(source, { pageIndexes: [1] });
  assert.equal(detected.pageCount, 2);
  assert.equal(detected.scannedPageCount, 1);
  assert.deepEqual(detected.pages.map((page) => page.pageIndex), [1]);
  assert.ok(detected.totalRuns >= 2);
});

test("OCR treats symbol-only checkmarks and decorative marks as page graphics", () => {
  const blocks = [{ paragraphs: [{ lines: [{ words: [
    { text: "ow", confidence: 0, bbox: { x0: 10, y0: 10, x1: 44, y1: 40 } },
    { text: "(®", confidence: 49, bbox: { x0: 46, y0: 10, x1: 80, y1: 40 } },
    { text: "Thanks", confidence: 92, bbox: { x0: 67, y0: 12, x1: 147, y1: 35 } },
    { text: "for", confidence: 96, bbox: { x0: 154, y0: 16, x1: 185, y1: 35 } },
  ] }] }] }];
  const words = wordsFromBlocks(blocks);
  assert.deepEqual(words.map((word) => word.text), ["ow", "(®", "Thanks for"]);
  assert.equal(words[0].graphic, true, "the checkmark-like OCR token should remain selectable artwork");
  assert.equal(words[1].graphic, true, "the decorative OCR token should remain selectable artwork");
  assert.equal(words[2].graphic, undefined, "ordinary OCR words should stay editable");
  assert.equal(words[2].bbox.x0, 67, "the editable region should begin after the graphic icon");
});

test("OCR keeps currency symbols editable and joins a separated rupee sign to its amount", () => {
  const words = wordsFromBlocks([{ paragraphs: [{ lines: [{ words: [
    { text: "₹", confidence: 0, bbox: { x0: 20, y0: 10, x1: 31, y1: 30 } },
    { text: "299.00", confidence: 85, bbox: { x0: 33, y0: 10, x1: 92, y1: 30 } },
  ] }] }] }]);
  assert.deepEqual(words.map((word) => word.text), ["₹299.00"]);
  assert.equal(words[0].graphic, undefined, "currency signs should stay editable text, not graphic placeholders");

  const recovered = mergeCurrencyWords([
    { text: "2299.00", confidence: 66, bbox: { x0: 22, y0: 10, x1: 92, y1: 30 } },
  ], [
    { text: "₹299.00", confidence: 0, bbox: { x0: 20, y0: 10, x1: 92, y1: 30 } },
  ]);
  assert.equal(recovered[0].text, "₹299.00", "the symbol-focused pass should correct a dropped/confused currency prefix");
  assert.equal(recovered[0].graphic, undefined);
});

test("OCR graphic runs support transform-only edits without text replacement", async () => {
  const source = await rasterPdf();
  const sourceHash = sha256Hex(source);
  const originalText = "ow";
  const bbox = { x0: 30, y0: 20, x1: 66, y1: 52 };
  const boxKey = [bbox.x0, bbox.y0, bbox.x1, bbox.y1].map((value) => Math.round(value * 10) / 10).join("-");
  const runId = `p0-ocr-o0-t${sha256Hex(Buffer.from(originalText, "utf8")).slice(0, 16)}-b${sha256Hex(Buffer.from(boxKey)).slice(0, 12)}-f${sourceHash.slice(0, 16)}`;
  const edited = await applyPdfOcrEdits(source, [{
    pageIndex: 0,
    runId,
    originalText,
    originalTextHash: sha256Hex(Buffer.from(originalText, "utf8")),
    mode: "ocr",
    moveOnly: true,
    bbox,
    offsetX: 80,
    offsetY: 18,
    scaleX: 1.35,
    scaleY: 0.9,
    rotation: 27,
  }], { sourceHash });
  assert.notEqual(sha256Hex(edited.bytes), sourceHash, "moving a graphic OCR run should create an edited PDF");
  assert.equal(edited.warnings.some((warning) => /font matching|replacement text/i.test(warning)), false, "graphic transforms must not use OCR text replacement");
});

test("OCR export rejects stale source hashes and tampered text identities", async () => {
  const source = await rasterPdf();
  const detected = await recognizePdfText(source);
  const run = detected.pages[0].runs[0];
  const edit = { pageIndex: run.pageIndex, runId: run.runId, originalText: run.originalText, originalTextHash: run.originalTextHash, replacementText: "changed", mode: "ocr", bbox: run.bbox };
  await assert.rejects(() => applyPdfOcrEdits(source, [edit], { sourceHash: "0".repeat(64) }), /source PDF changed/);
  await assert.rejects(() => applyPdfOcrEdits(source, [{ ...edit, originalText: "tampered" }], { sourceHash: sha256Hex(source) }), /original text hash/);
});

test("OCR export embeds longer replacements and reports visual overflow", async () => {
  const source = await rasterPdf();
  const detected = await recognizePdfText(source);
  const run = detected.pages[0].runs.find((item) => /OCR/i.test(item.text));
  const replacement = "THIS IS A MUCH LONGER REPLACEMENT TEXT";
  const edited = await applyPdfOcrEdits(source, [{
    pageIndex: run.pageIndex,
    runId: run.runId,
    originalText: run.originalText,
    originalTextHash: run.originalTextHash,
    replacementText: replacement,
    mode: "ocr",
    bbox: run.bbox,
    confidence: run.confidence,
  }], { sourceHash: sha256Hex(source) });
  assert.ok(edited.warnings.some((warning) => /wider than the original text region/i.test(warning)));
  const output = await PDFDocument.load(edited.bytes);
  assert.equal(output.getPageCount(), 1);
  assert.notEqual(sha256Hex(edited.bytes), sha256Hex(source), "the exported bytes should contain the edited page image");
});

test("OCR keeps the full leading word on isolated text over a dark slide", async () => {
  const source = await yellowSlidePdf();
  const detected = await recognizePdfText(source);
  const run = detected.pages[0].runs.find((item) => /lecture\s+number/i.test(item.text));
  assert.ok(run, `Expected the complete slide heading, got: ${detected.pages[0].runs.map((item) => item.text).join(" | ")}`);
  assert.match(run.text, /^Lecture\s+Number$/i);
  assert.ok(run.bbox.x0 < 1000, "the OCR region must include the leading letters so an edit cannot leave them behind");
});

test("OCR raster edits keep neighbouring artwork out of the replacement background", () => {
  const canvas = createCanvas(1000, 240);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  // This nearby rule is outside the source text mask. A distant background
  // sampler would copy it into the cleared text region as a red rectangle.
  context.fillStyle = "#ff0000";
  context.fillRect(100, 46, 500, 7);
  context.fillStyle = "#ffffff";
  context.font = "700 52px Arial";
  context.fillText("Regular Expression", 100, 125);

  const warnings = applyRasterTextEdits(canvas, [{
    originalText: "Regular Expression",
    replacementText: "Regular Expressions",
    bbox: { x0: 100, y0: 80, x1: 600, y1: 140 },
    confidence: 96,
  }]);
  assert.ok(warnings.some((warning) => /wider than the original/i.test(warning)));
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const pixelAt = (x, y) => {
    const offset = (y * canvas.width + x) * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  };
  const redPixelsInsideMask = [];
  for (let y = 70; y < 150; y += 1) {
    for (let x = 90; x < 610; x += 1) {
      const [red, green, blue] = pixelAt(x, y);
      if (red > 120 && red > green * 1.5 && red > blue * 1.5) redPixelsInsideMask.push(1);
    }
  }
  assert.equal(redPixelsInsideMask.length, 0, "nearby red artwork must not leak into the cleared source region");
  assert.deepEqual(pixelAt(300, 49), [255, 0, 0], "artwork outside the source region must remain unchanged");
  let whitePixels = 0;
  for (let y = 70; y < 150; y += 1) {
    for (let x = 90; x < 610; x += 1) {
      const [red, green, blue] = pixelAt(x, y);
      if (red > 180 && green > 180 && blue > 180) whitePixels += 1;
    }
  }
  assert.ok(whitePixels > 100, "the replacement should use the original white visual colour");
});

test("OCR raster edits move the replacement while clearing the original region", () => {
  const canvas = createCanvas(500, 180);
  const context = canvas.getContext("2d");
  context.fillStyle = "#101820";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.font = "700 48px Arial";
  const text = "Move";
  const metrics = context.measureText(text);
  const baseline = 90;
  context.fillText(text, 30, baseline);
  applyRasterTextEdits(canvas, [{
    originalText: text,
    replacementText: text,
    moveOnly: true,
    bbox: { x0: 30, y0: baseline - metrics.actualBoundingBoxAscent, x1: 30 + metrics.width, y1: baseline + metrics.actualBoundingBoxDescent },
    offsetX: 150,
    offsetY: 25,
  }]);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const lightPixels = (x0, y0, x1, y1) => {
    let count = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      if (pixels[offset] > 180 && pixels[offset + 1] > 180 && pixels[offset + 2] > 180) count += 1;
    }
    return count;
  };
  assert.ok(lightPixels(170, 55, 300, 140) > 100, "the moved replacement should be painted at its new page position");
  assert.ok(lightPixels(15, 15, 145, 105) < 100, "the original OCR text region should be cleared before painting the moved text");
});

test("OCR raster edits apply size and rotation around the moved text region", () => {
  const canvas = createCanvas(500, 240);
  const context = canvas.getContext("2d");
  context.fillStyle = "#101820";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.font = "700 42px Arial";
  const text = "Rotate";
  const baseline = 120;
  const metrics = context.measureText(text);
  context.fillText(text, 90, baseline);
  const warnings = applyRasterTextEdits(canvas, [{
    originalText: text,
    replacementText: text,
    moveOnly: true,
    bbox: { x0: 90, y0: baseline - metrics.actualBoundingBoxAscent, x1: 90 + metrics.width, y1: baseline + metrics.actualBoundingBoxDescent },
    scale: 1.5,
    rotation: 90,
  }]);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let lightPixels = 0;
  for (let y = 25; y < 215; y += 1) for (let x = 20; x < 300; x += 1) {
    const offset = (y * canvas.width + x) * 4;
    if (pixels[offset] > 180 && pixels[offset + 1] > 180 && pixels[offset + 2] > 180) lightPixels += 1;
  }
  assert.ok(lightPixels > 100, "the transformed OCR replacement should remain visible");
  assert.ok(!warnings.some((warning) => /wider than the original/i.test(warning)), "moving existing pixels should not report replacement-text overflow");
});

test("OCR raster edits apply existing-text formatting without changing the source identity", () => {
  const canvas = createCanvas(560, 220);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#1c2d3d";
  context.font = "400 42px Arial";
  const text = "Format me";
  const baseline = 120;
  const metrics = context.measureText(text);
  context.fillText(text, 80, baseline);
  applyRasterTextEdits(canvas, [{
    originalText: text,
    replacementText: text,
    bbox: { x0: 80, y0: baseline - metrics.actualBoundingBoxAscent, x1: 80 + metrics.width, y1: baseline + metrics.actualBoundingBoxDescent },
    format: {
      fontFamily: "Courier",
      fontSize: 50,
      bold: true,
      italic: true,
      underline: true,
      color: "#d12a2a",
      alignment: "center",
      characterSpacing: 2,
      lineSpacing: 1.4,
    },
  }]);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let redPixels = 0;
  for (let y = 45; y < 170; y += 1) for (let x = 60; x < 500; x += 1) {
    const offset = (y * canvas.width + x) * 4;
    if (pixels[offset] > 150 && pixels[offset] > pixels[offset + 1] * 1.5 && pixels[offset] > pixels[offset + 2] * 1.5) redPixels += 1;
  }
  assert.ok(redPixels > 100, "formatted OCR text should use the selected colour");
  let underlinePixels = 0;
  for (let y = 121; y <= 130; y += 1) for (let x = 70; x < 500; x += 1) {
    const offset = (y * canvas.width + x) * 4;
    if (pixels[offset] > 150 && pixels[offset] > pixels[offset + 1] * 1.5 && pixels[offset] > pixels[offset + 2] * 1.5) underlinePixels += 1;
  }
  assert.ok(underlinePixels > 10, "formatted OCR text should render its underline");
});

test("OCR move-only edits preserve the original glyph pixels without font matching", () => {
  const canvas = createCanvas(520, 180);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111111";
  context.font = "700 52px Arial";
  context.fillText("CASE", 30, 100);
  // A high-contrast mark inside the OCR region stands in for a logo icon that
  // OCR text reconstruction must not replace with a guessed character.
  context.fillStyle = "#ef3f7a";
  context.fillRect(155, 62, 18, 18);
  let matched = false;
  applyRasterTextEdits(canvas, [{
    originalText: "CASE",
    replacementText: "CASE",
    moveOnly: true,
    bbox: { x0: 30, y0: 52, x1: 190, y1: 108 },
    offsetX: 220,
    offsetY: 20,
  }], { onFontMatch: () => { matched = true; } });
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const pinkPixels = (x0, y0, x1, y1) => {
    let count = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
      const offset = (y * canvas.width + x) * 4;
      if (pixels[offset] > 180 && pixels[offset + 2] > 80 && pixels[offset + 1] < 150) count += 1;
    }
    return count;
  };
  assert.equal(matched, false, "move-only OCR edits must not invoke font matching");
  assert.ok(pinkPixels(245, 72, 430, 150) > 100, "the original logo pixels should move with the OCR region");
  assert.ok(pinkPixels(15, 40, 215, 125) < 20, "the original logo pixels should be cleared from their old position");
});

test("OCR font matching chooses a close installed family for image-only text", () => {
  const canvas = createCanvas(1000, 240);
  const context = canvas.getContext("2d");
  context.fillStyle = "#101820";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f5ef22";
  context.font = '700 52px "Comic Sans MS"';
  const text = "Lecture Number";
  const metrics = context.measureText(text);
  const baseline = 130;
  context.fillText(text, 100, baseline);
  const matches = [];
  applyRasterTextEdits(canvas, [{
    originalText: text,
    replacementText: "Lecture Number 11",
    bbox: {
      x0: 100,
      y0: baseline - metrics.actualBoundingBoxAscent,
      x1: 100 + metrics.width,
      y1: baseline + metrics.actualBoundingBoxDescent,
    },
    confidence: 96,
  }], {
    availableFonts: GlobalFonts.families.map((font) => font.family),
    onFontMatch: (match) => matches.push(match),
  });
  assert.equal(matches.length, 1);
  assert.ok(["Comic Sans MS", "Chalkboard SE", "Chalkboard", "Bradley Hand", "Marker Felt", "Noteworthy"].includes(matches[0].fontFamily), `Expected a handwritten match, got ${matches[0].fontFamily}`);
  assert.ok(matches[0].scaleX > 0, "the matched font should retain the source text width");
});

test("OCR Latin matching ignores incompatible system and bitmap fonts", () => {
  const canvas = createCanvas(1000, 240);
  const context = canvas.getContext("2d");
  context.fillStyle = "#9a6514";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.font = "700 52px Arial";
  const text = "PREMIUM PERSONALISED";
  const metrics = context.measureText(text);
  context.fillText(text, 100, 130);
  const matches = [];
  applyRasterTextEdits(canvas, [{
    originalText: text,
    replacementText: "PREMIU PERSONALISED",
    bbox: {
      x0: 100,
      y0: 130 - metrics.actualBoundingBoxAscent,
      x1: 100 + metrics.width,
      y1: 130 + metrics.actualBoundingBoxDescent,
    },
  }], {
    availableFonts: ["Kannada MN", "Gurmukhi MT", "Mishafi Gold", "GB18030 Bitmap", "Zapfino", "Arial", "Times New Roman"],
    onFontMatch: (match) => matches.push(match),
  });
  assert.equal(matches.length, 1);
  assert.ok(!["Kannada MN", "Gurmukhi MT", "Mishafi Gold", "GB18030 Bitmap", "Zapfino"].includes(matches[0].fontFamily));
  assert.ok(matches[0].fontSize < 200, "a Latin replacement must not use a pathological system-font metric");
});
