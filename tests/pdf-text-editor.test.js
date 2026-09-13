import assert from "node:assert/strict";
import test from "node:test";
import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts, decodePDFRawStream, rgb } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { applyPdfTextEdits, extractPdfTextRuns } from "../lib/pdf-text-editor.js";
import { createPdfTextPreview } from "../lib/pdf-text-preview.js";
import { mergeAdjacentTextRuns } from "../lib/pdf-text-runs.js";

const samplePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

async function createFixture() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const firstPage = document.addPage([500, 320]);
  firstPage.setRotation(degrees(90));
  firstPage.drawRectangle({ x: 24, y: 24, width: 210, height: 90, color: rgb(0.95, 0.85, 0.62), opacity: 0.42 });
  firstPage.drawText("First occurrence", { x: 35, y: 260, font, size: 18, color: rgb(0.72, 0.08, 0.12), opacity: 0.68 });
  firstPage.drawText("Duplicate", { x: 35, y: 210, font, size: 16, color: rgb(0.1, 0.3, 0.7) });
  firstPage.drawText("Duplicate", { x: 35, y: 170, font, size: 16, color: rgb(0.1, 0.3, 0.7) });
  const secondPage = document.addPage([500, 320]);
  const image = await document.embedPng(samplePng);
  secondPage.drawImage(image, { x: 34, y: 230, width: 32, height: 32 });
  secondPage.drawText("Across pages", { x: 35, y: 180, font, size: 18, color: rgb(0.15, 0.55, 0.3) });
  return document.save({ useObjectStreams: false });
}

async function searchableText(bytes) {
  const pdf = await getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ disableCombineTextItems: true });
    pages.push(content.items.map((item) => item.str).join(" "));
  }
  return pages;
}

function firstStream(document, page) {
  const contents = page.node.Contents();
  const reference = contents instanceof PDFArray ? contents.get(0) : contents;
  return document.context.lookup(reference);
}

function decodedPageContent(document, page) {
  return Buffer.from(decodePDFRawStream(firstStream(document, page)).decode()).toString("latin1");
}

function xObjectCount(page) {
  const resources = page.node.Resources();
  const xObjects = resources?.lookupMaybe(PDFName.XObject, PDFDict);
  return xObjects ? [...xObjects.entries()].length : 0;
}

function type0Fixture(operator = "Tj", baseFont = "Helvetica") {
  return (async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([400, 260]);
    const context = document.context;
    const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0001> <0041> <0002> <0042> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end`;
    const cmapReference = context.register(context.flateStream(Buffer.from(cmap, "latin1")));
    const descendantReference = context.register(context.obj({
      Type: PDFName.Font,
      Subtype: PDFName.of("CIDFontType0"),
      BaseFont: PDFName.of(baseFont),
      CIDSystemInfo: context.obj({ Registry: context.obj("Adobe"), Ordering: context.obj("Identity"), Supplement: 0 }),
      DW: 1000,
    }));
    const type0Reference = context.register(context.obj({
      Type: PDFName.Font,
      Subtype: PDFName.of("Type0"),
      BaseFont: PDFName.of(baseFont),
      Encoding: PDFName.of("Identity-H"),
      DescendantFonts: context.obj([descendantReference]),
      ToUnicode: cmapReference,
    }));
    const resources = page.node.Resources();
    resources.set(PDFName.Font, context.obj({ F1: type0Reference }));
    const textOperator = operator === "TJ" ? "[<0001> -120 <0002>] TJ" : "<0001> Tj";
    page.node.set(PDFName.Contents, context.register(context.flateStream(Buffer.from(`BT /F1 18 Tf 1 0 0 1 40 180 Tm ${textOperator} ET`, "latin1"))));
    return document.save({ useObjectStreams: false });
  })();
}

test("PDF text extraction creates stable, distinct run IDs for duplicate text", async () => {
  const source = await createFixture();
  const first = await extractPdfTextRuns(source);
  const second = await extractPdfTextRuns(source);
  assert.equal(first.pageCount, 2);
  assert.deepEqual(first, second);
  const duplicates = first.pages[0].runs.filter((run) => run.text === "Duplicate");
  assert.equal(duplicates.length, 2);
  assert.notEqual(duplicates[0].runId, duplicates[1].runId);
  assert.equal(duplicates[0].originalTextHash, duplicates[1].originalTextHash);
  assert.ok(first.pages[0].runs.every((run) => run.runId.startsWith("p0-o")));
  assert.equal(first.pages[1].runs[0].pageIndex, 1);
});

test("PDF.js glyph fragments merge into one logical word without merging real spaces", () => {
  const items = [
    { str: "अ", transform: [19.5, 0, 0, 19.5, 259.5, 760.92], width: 15, height: 19.5, fontName: "g_d0_f1" },
    { str: "स्व", transform: [19.5, 0, 0, 19.5, 274.5, 760.92], width: 0, height: 19.5, fontName: "g_d0_f1" },
    { str: " ", transform: [19.5, 0, 0, 19.5, 274.5, 760.92], width: 24.9, height: 19.5, fontName: "g_d0_f1" },
    { str: "ी", transform: [19.5, 0, 0, 19.5, 293.2, 760.92], width: 5.77, height: 19.5, fontName: "g_d0_f1" },
    { str: "करण", transform: [19.5, 0, 0, 19.5, 298.97, 760.92], width: 37, height: 19.5, fontName: "g_d0_f1" },
    { str: "यह", transform: [11.25, 0, 0, 11.25, 54, 709.92], width: 11.65, height: 11.25, fontName: "g_d0_f2" },
    { str: " ", transform: [11.25, 0, 0, 11.25, 65.65, 709.92], width: 7.38, height: 11.25, fontName: "g_d0_f2" },
    { str: "शब्द", transform: [11.25, 0, 0, 11.25, 71.19, 709.92], width: 24, height: 11.25, fontName: "g_d0_f2" },
  ];
  let ordinal = 0;
  const runs = items.flatMap((item, itemIndex) => item.str.trim() ? [{ item, itemIndex, ordinal: ordinal++, operatorIndex: itemIndex, operatorOrdinals: [ordinal - 1], operatorEndIndex: itemIndex, text: item.str, originalText: item.str, operatorText: item.str, editable: true, reason: "" }] : []);
  const merged = mergeAdjacentTextRuns(runs, items);
  assert.deepEqual(merged.map((run) => run.text), ["अस्वीकरण", "यह", "शब्द"]);
  assert.deepEqual(merged[0].operatorOrdinals, [0, 1, 2, 3]);
  assert.equal(Math.round(merged[0].item.width), 76);
});

test("PDF text edits support multiple pages, same-font characters, overflow warnings, and searchable output", async () => {
  const source = await createFixture();
  const originalDocument = await PDFDocument.load(source);
  const originalPages = originalDocument.getPages();
  const extracted = await extractPdfTextRuns(source);
  const firstRun = extracted.pages[0].runs.find((run) => run.text === "First occurrence");
  const duplicateRun = extracted.pages[0].runs.find((run) => run.text === "Duplicate");
  const secondPageRun = extracted.pages[1].runs.find((run) => run.text === "Across pages");
  const edits = [firstRun, duplicateRun, secondPageRun].map((run, index) => ({
    pageIndex: run.pageIndex,
    runId: run.runId,
    originalTextHash: run.originalTextHash,
    replacementText: index === 0 ? "Café" : index === 1 ? "A much longer duplicate label" : "Another page",
  }));
  const originalContent = decodedPageContent(originalDocument, originalPages[0]);
  const colorCommand = originalContent.match(/[\d.]+ [\d.]+ [\d.]+ (?:rg|scn)/)?.[0];
  const sourceSnapshot = Buffer.from(source);
  const output = await applyPdfTextEdits(source, edits);
  assert.equal(output.editCount, 3);
  assert.ok(output.warnings.some((warning) => warning.includes("overflow")));
  assert.deepEqual(Buffer.from(source), sourceSnapshot, "the original PDF bytes must not be modified");

  const outputDocument = await PDFDocument.load(output.bytes);
  const outputPages = outputDocument.getPages();
  assert.equal(outputPages.length, originalPages.length);
  assert.equal(outputPages[0].getRotation().angle, 90);
  assert.equal(xObjectCount(outputPages[1]), xObjectCount(originalPages[1]));
  const editedContent = decodedPageContent(outputDocument, outputPages[0]);
  assert.ok(editedContent.includes("210 90 l"), "the original vector rectangle should remain in the page stream");
  if (colorCommand) assert.ok(editedContent.includes(colorCommand), "the original text color command should remain unchanged");
  const text = await searchableText(output.bytes);
  assert.match(text[0], /Café/);
  assert.match(text[0], /much longer duplicate label/);
  assert.match(text[1], /Another page/);
});

test("PDF text editor can replace a run with an empty string without changing its font", async () => {
  const input = await createFixture();
  const extracted = await extractPdfTextRuns(input);
  const run = extracted.pages[0].runs.find((item) => item.text === "First occurrence");
  const edited = await applyPdfTextEdits(input, [{ pageIndex: 0, runId: run.runId, originalTextHash: run.originalTextHash, replacementText: "" }]);
  const after = await extractPdfTextRuns(edited.bytes);
  assert.equal(after.pages[0].runs[0].text, "");
  assert.deepEqual(edited.warnings, []);
});

test("PDF text edits reject stale identities, duplicate submissions, and encrypted or invalid input safely", async () => {
  const source = await createFixture();
  const extracted = await extractPdfTextRuns(source);
  const run = extracted.pages[0].runs[0];
  await assert.rejects(() => applyPdfTextEdits(source, [{ pageIndex: run.pageIndex, runId: `${run.runId}-stale`, originalTextHash: run.originalTextHash, replacementText: "changed" }]), /selected text run|original text|run/);
  await assert.rejects(() => applyPdfTextEdits(source, [
    { pageIndex: run.pageIndex, runId: run.runId, originalTextHash: run.originalTextHash, replacementText: "one" },
    { pageIndex: run.pageIndex, runId: run.runId, originalTextHash: run.originalTextHash, replacementText: "two" },
  ]), /more than once/);
  await assert.rejects(() => applyPdfTextEdits(Buffer.from("not a PDF"), [{ pageIndex: 0, runId: "invalid", originalTextHash: "0".repeat(64), replacementText: "changed" }], { password: true }), /Password-protected|encrypted|unsupported/);
  await assert.rejects(() => applyPdfTextEdits(source, [], {}), /at least one text edit/);
});

test("PDF text extraction identifies pages without selectable text as non-editable", async () => {
  const document = await PDFDocument.create();
  document.addPage([300, 200]);
  const extracted = await extractPdfTextRuns(await document.save());
  assert.equal(extracted.pages.length, 1);
  assert.equal(extracted.pages[0].editableCount, 0);
  assert.deepEqual(extracted.pages[0].runs, []);
});

test("PDF text editor uses a bundled fallback font when a Type0 font cannot encode the replacement", async () => {
  const source = await type0Fixture();
  const extracted = await extractPdfTextRuns(source);
  assert.equal(extracted.pages[0].runs[0].text, "A");
  const run = extracted.pages[0].runs[0];
  const output = await applyPdfTextEdits(source, [{ pageIndex: 0, runId: run.runId, originalTextHash: run.originalTextHash, replacementText: "New" }]);
  assert.ok(output.warnings.some((warning) => warning.includes("bundled Helvetica fallback")));
  assert.match((await searchableText(output.bytes))[0], /New/);
  await assert.rejects(() => applyPdfTextEdits(source, [{ pageIndex: 0, runId: run.runId, originalTextHash: run.originalTextHash, replacementText: "漢字" }]), /bundled fallback font/);
});

test("native text replacement keeps the original bold font resource and point size", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([420, 220]);
  const font = await document.embedFont(StandardFonts.HelveticaBold);
  page.drawText("Bold source", { x: 35, y: 100, font, size: 28, color: rgb(0.1, 0.35, 0.7) });
  const source = await document.save({ useObjectStreams: false });
  const extracted = await extractPdfTextRuns(source);
  const run = extracted.pages[0].runs[0];
  const output = await applyPdfTextEdits(source, [{ pageIndex: 0, runId: run.runId, originalTextHash: run.originalTextHash, replacementText: "Bold replacement" }]);
  assert.equal(output.warnings.some((warning) => /bundled fallback/i.test(warning)), false);
  const outputDocument = await PDFDocument.load(output.bytes);
  const content = decodedPageContent(outputDocument, outputDocument.getPages()[0]);
  assert.match(content, /\/Helvetica-Bold-[^ ]+ 28 Tf/);
  assert.doesNotMatch(content, /MTFallback/);
  assert.match((await searchableText(output.bytes))[0], /Bold replacement/);
});

test("fallback text keeps bold styling when the original bold font cannot encode it", async () => {
  const source = await type0Fixture("Tj", "Arial-BoldMT");
  const extracted = await extractPdfTextRuns(source);
  const run = extracted.pages[0].runs[0];
  const output = await applyPdfTextEdits(source, [{ pageIndex: 0, runId: run.runId, originalTextHash: run.originalTextHash, replacementText: "New" }]);
  assert.ok(output.warnings.some((warning) => /bundled Helvetica-Bold fallback/i.test(warning)));
  const outputDocument = await PDFDocument.load(output.bytes);
  assert.match(Buffer.from(output.bytes).toString("latin1"), /Helvetica-Bold/);
  assert.match(decodedPageContent(outputDocument, outputDocument.getPages()[0]), /18 Tf/);
});

test("PDF text editor preserves numeric TJ positioning adjustments", async () => {
  const source = await type0Fixture("TJ");
  const extracted = await extractPdfTextRuns(source);
  const run = extracted.pages[0].runs[0];
  assert.equal(run.text, "AB");
  const output = await applyPdfTextEdits(source, [{ pageIndex: 0, runId: run.runId, originalTextHash: run.originalTextHash, replacementText: "CD" }]);
  const outputDocument = await PDFDocument.load(output.bytes);
  assert.match(decodedPageContent(outputDocument, outputDocument.getPages()[0]), /-120/);
  assert.match((await searchableText(output.bytes))[0], /CD/);
});

test("PDF text editor replaces grouped text operators without leaving the original glyphs", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 220]);
  const context = document.context;
  const fontReference = context.register(context.obj({ Type: PDFName.Font, Subtype: PDFName.of("Type1"), BaseFont: PDFName.of("Helvetica"), Encoding: PDFName.of("WinAnsiEncoding") }));
  page.node.Resources().set(PDFName.Font, context.obj({ F1: fontReference }));
  page.node.set(PDFName.Contents, context.register(context.flateStream(Buffer.from("BT /F1 18 Tf 40 120 Tm (A) Tj 14 0 Td (B) Tj ET", "latin1"))));
  const source = await document.save({ useObjectStreams: false });
  const extracted = await extractPdfTextRuns(source);
  const first = extracted.pages[0].runs[0];
  const second = extracted.pages[0].runs[1];
  const output = await applyPdfTextEdits(source, [{ pageIndex: 0, runId: first.runId, originalTextHash: first.originalTextHash, originalText: "AB", operatorOrdinals: [first.ordinal, second.ordinal], replacementText: "CD" }]);
  const text = (await searchableText(output.bytes))[0];
  assert.match(text, /CD/);
  assert.doesNotMatch(text, /AB/);
});

test("PDF text editor replaces identical same-position copies together", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 220]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Same", { x: 40, y: 120, font, size: 18 });
  page.drawText("Same", { x: 40, y: 120, font, size: 18 });
  const source = await document.save({ useObjectStreams: false });
  const extracted = await extractPdfTextRuns(source);
  const copies = extracted.pages[0].runs.filter((run) => run.text === "Same");
  assert.equal(copies.length, 2);
  const output = await applyPdfTextEdits(source, [{
    pageIndex: 0,
    runId: copies[0].runId,
    originalText: "Same",
    originalTextHash: copies[0].originalTextHash,
    operatorGroups: copies.map((run) => ({ operatorOrdinal: run.ordinal, operatorOrdinals: [run.ordinal] })),
    replacementText: "Changed",
  }]);
  const text = (await searchableText(output.bytes))[0];
  assert.equal((text.match(/Changed/g) || []).length, 2);
  assert.doesNotMatch(text, /Same/);
  const preview = await createPdfTextPreview(source, [{
    pageIndex: 0,
    operatorOrdinal: copies[0].ordinal,
    operatorGroups: copies.map((run) => ({ operatorOrdinal: run.ordinal, operatorOrdinals: [run.ordinal] })),
    replacementText: "Previewed",
    mode: "native",
  }]);
  const previewText = (await searchableText(preview))[0];
  assert.equal((previewText.match(/Previewed/g) || []).length, 2);
  assert.doesNotMatch(previewText, /Same/);
});

test("live PDF preview rewrites native text instead of drawing over the original", async () => {
  const source = await createFixture();
  const extracted = await extractPdfTextRuns(source);
  const run = extracted.pages[0].runs.find((item) => item.text === "First occurrence");
  const preview = await createPdfTextPreview(source, [{ pageIndex: run.pageIndex, operatorOrdinal: run.ordinal, replacementText: "Changed heading", mode: "native" }]);
  const after = await extractPdfTextRuns(preview);
  assert.equal(after.pages[0].runs.some((item) => item.text === "Changed heading"), true);
  assert.equal(after.pages[0].runs.some((item) => item.text === "First occurrence"), false);
});

test("live PDF preview removes native text when the replacement is empty", async () => {
  const source = await createFixture();
  const extracted = await extractPdfTextRuns(source);
  const run = extracted.pages[0].runs.find((item) => item.text === "First occurrence");
  const preview = await createPdfTextPreview(source, [{ pageIndex: run.pageIndex, operatorOrdinal: run.ordinal, replacementText: "", mode: "native" }]);
  const after = await extractPdfTextRuns(preview);
  assert.equal(after.pages[0].runs.some((item) => item.text === "First occurrence"), false);
  assert.equal(after.pages[0].runs[0].text, "");
});

test("native extraction supports ReportLab WinAnsi bullet text", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage([400, 220]);
  const context = document.context;
  const fontReference = context.register(context.obj({
    Type: PDFName.Font,
    Subtype: PDFName.of("Type1"),
    BaseFont: PDFName.of("Helvetica"),
    Encoding: PDFName.of("WinAnsiEncoding"),
  }));
  page.node.Resources().set(PDFName.Font, context.obj({ F1: fontReference }));
  page.node.set(PDFName.Contents, context.register(context.flateStream(Buffer.from("BT /F1 12 Tf 40 100 Td (\\177 Bullet text) Tj ET", "latin1"))));
  const source = await document.save({ useObjectStreams: false });
  const extracted = await extractPdfTextRuns(source);
  const run = extracted.pages[0].runs[0];
  assert.equal(run.text, "• Bullet text");
  assert.equal(run.editable, true);
  const output = await applyPdfTextEdits(source, [{ pageIndex: run.pageIndex, runId: run.runId, originalTextHash: run.originalTextHash, replacementText: "• Updated text" }]);
  assert.match((await searchableText(output.bytes))[0], /Updated text/);
});
