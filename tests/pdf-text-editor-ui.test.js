import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("PDF text editor is exposed as a dedicated tool with history navigation", async () => {
  const route = await read("pages/pdf-text-editor.jsx");
  const shell = await read("components/pdf-text-editor.jsx");
  const navigation = await read("components/app-shell.jsx");
  const history = await read("components/tool-history.jsx");
  const comingSoon = await read("pages/coming-soon.jsx");
  assert.match(route, /PdfTextEditor/);
  assert.match(navigation, /href: "\/pdf-text-editor"/);
  assert.match(shell, /ToolViewTabs/);
  assert.match(shell, /ToolHistory tool="pdf-text-editor"/);
  assert.match(history, /"pdf-text-editor"/);
  assert.match(navigation, /label: "PDF editor"[^\n]+beta: true/);
  assert.match(navigation, /label: "PDF text editor"[^\n]+beta: true/);
  assert.match(navigation, /nav-beta/);
  assert.match(comingSoon, /\["PDF text editor"[^\n]+"Beta", "\/pdf-text-editor"\]/);
});

test("PDF text editor keeps browser mode disabled and submits identity-checked edits", async () => {
  const shell = await read("components/pdf-text-editor.jsx");
  const intake = await read("lib/job-intake.js");
  const worker = await read("worker/index.js");
  assert.match(shell, /Browser mode disabled/);
  assert.doesNotMatch(shell, /value="browser"/);
  assert.match(shell, /50 MB/);
  assert.match(shell, /originalTextHash/);
  assert.match(shell, /replacementText/);
  assert.match(shell, /Zoom out/);
  assert.match(shell, /Zoom in/);
  assert.match(shell, /Preview zoom/);
  assert.match(shell, /import\("\.\.\/lib\/pdf-text-preview\.js"\)/);
  assert.match(shell, /await Promise\.all\(pages\.map\(\(page\) => previewPdf\.getPage/);
  assert.match(shell, /setPreviewRevision\(\(current\) => current \+ 1\)/);
  assert.match(shell, /key=\{`\$\{model\.pageIndex\}-\$\{previewRevision\}`\}/);
  assert.match(shell, /sourceBytesRef\.current = data\.slice\(\)/);
  assert.match(shell, /\.\.\.operator,\s*pageIndex,/);
  assert.match(shell, /operatorOrdinal: run.ordinal/);
  assert.match(shell, /Rebuilding the real PDF preview/);
  assert.match(shell, /applyRasterTextEdits/);
  assert.doesNotMatch(shell, /pdf-text-edit-preview/);
  assert.match(shell, /Continue editing/);
  assert.match(await read("lib/pdf-text-preview.js"), /document.context.flateStream/);
  assert.match(await read("lib/pdf-ocr-raster.js"), /expandedBox/);
  assert.match(await read("lib/pdf-ocr.js"), /applyRasterTextEdits/);
  assert.match(shell, /devicePixelRatio/);
  assert.match(shell, /renderViewport/);
  assert.match(await read("styles/globals.css"), /\.pdf-text-page-frame \{[^}]*overflow: hidden/);
  assert.match(await read("styles/globals.css"), /\.pdf-text-page \{ zoom: var\(--pdf-text-preview-zoom, 1\); \}/);
  assert.match(intake, /pdf-text-editor/);
  assert.match(worker, /applyPdfTextEdits/);
  assert.match(shell, /inspectPdfWithOcr/);
  assert.match(shell, /OCR fallback/);
  assert.match(await read("components/processing-client.js"), /application\/x-ndjson/);
  assert.match(await read("components/processing-client.js"), /response\.body\.getReader\(\)/);
  assert.match(await read("components/processing-client.js"), /agent_update_required/);
  assert.match(await read("components/processing-client.js"), /PDF OCR requires the latest Local Agent/);
  assert.match(shell, /capabilities\.pdf\?\.ocr !== true/);
  assert.match(await read("pages/api/pdf/ocr.js"), /type: "progress"/);
  assert.match(await read("agent/server.js"), /application\/x-ndjson/);
  assert.match(await read("lib/pdf-ocr.js"), /tesseract/);
  assert.match(await read("pages/api/pdf/ocr.js"), /recognizePdfText/);
  assert.match(worker, /without rasterizing/);
  assert.ok(shell.indexOf("Add one PDF") < shell.indexOf("pdf-text-editor-shell"), "the upload card should be above the preview shell");
});
