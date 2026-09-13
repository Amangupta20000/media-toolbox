import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { applyPdfOcrEdits, recognizePdfText, sha256Hex } from "../lib/pdf-ocr.js";

async function rasterPdf() {
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
  const page = document.addPage([600, 180]);
  const image = await document.embedPng(canvas.toBuffer("image/png"));
  page.drawImage(image, { x: 0, y: 0, width: 600, height: 180 });
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
