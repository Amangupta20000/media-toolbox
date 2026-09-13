import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("PDF editor renders full previews at high resolution while keeping thumbnails small", async () => {
  const shell = await read("components/pdf-editor.jsx");
  const previewRoute = await read("pages/api/pdf/preview.js");
  const workerRoute = await read("pages/api/pdf/worker.js");
  const licenseClient = await read("components/license-client.js");
  const licenseProxy = await read("pages/api/license/[...path].js");
  assert.match(shell, /const pixelRatio = Math\.min\(3, Math\.max\(2,/);
  assert.match(shell, /const renderViewport = pageInfo\.pdfPage\.getViewport\(\{ scale: scale \* pixelRatio, rotation \}\)/);
  assert.match(shell, /canvas\.style\.width = "100%"/);
  assert.match(previewRoute, /request\.query\.thumbnail === "1" \? "40" : "180"/);
  assert.match(shell, /GlobalWorkerOptions\.workerSrc = "\/api\/pdf\/worker"/);
  assert.match(shell, /const scale = .*previewZoom/);
  assert.match(shell, /surfaceSize/);
  assert.match(shell, /imagePreviewStyle\(page, image, placement\)/);
  assert.match(shell, /Set rotation for image/);
  assert.match(shell, /rotation: normalizeImageRotation\(image\.rotation\)/);
  assert.match(shell, /Text box/);
  assert.match(shell, /Text size for text box/);
  assert.match(shell, /Background color for text box/);
  assert.match(shell, /onChangeTextBoxes/);
  assert.match(shell, /History/);
  assert.match(shell, /undoDocument/);
  assert.match(shell, /redoDocument/);
  assert.match(shell, /⌘\/Ctrl\+Z undo/);
  assert.match(shell, /history === "coalesce"/);
  assert.match(shell, /Delete page/);
  assert.match(shell, /Drop here/);
  assert.match(shell, /textBoxFontName/);
  assert.match(shell, /textBoxFontDefinition/);
  assert.match(shell, /contentEditable/);
  assert.match(shell, /selection.start < 0 \|\| selection.end < selection.start/);
  assert.match(shell, /restoreTextSelection\(editor, selection\)/);
  assert.match(shell, /applyTextBoxRangeStyle/);
  assert.match(shell, /runs: Array\.isArray\(textBox\.runs\)/);
  assert.match(await read("lib/pdf-text-box.js"), /Roboto/);
  assert.match(await read("lib/pdf-text-box.js"), /NotoSansDevanagari/);
  assert.match(await read("lib/pdf-text-box.js"), /layoutPdfTextRuns/);
  assert.match(await read("styles/globals.css"), /roboto-regular\.ttf/);
  assert.match(await read("styles/globals.css"), /noto-sans-devanagari-regular\.ttf/);
  assert.match(shell, /images\.length \? <ImageOverlayLayer[\s\S]*?textBoxes\.length \? null : <button className="blank-page-message"/);
  assert.match(shell, /setKeepResult\(Boolean\(locations\.local\?\.connected\)\)/);
  assert.match(shell, /keepResultTouchedRef/);
  assert.match(shell, /resultFilenameStem/);
  assert.match(shell, /form\.append\("filename"/);
  assert.match(shell, /Saved PDF name/);
  assert.match(await read("lib/job-intake.js"), /safePdfOutputFilename/);
  assert.match(await read("worker/index.js"), /manifest\.outputFilename/);
  const styles = await read("styles/globals.css");
  assert.match(styles, /\.pdf-editor-shell \{[^}]*overflow: hidden/);
  assert.match(styles, /\.pdf-retention-check \{[^}]*font-size: 13px/);
  assert.match(styles, /\.pdf-retention-row \{/);
  assert.match(workerRoute, /path\.join\(process\.cwd\(\), "node_modules", "pdfjs-dist"/);
  assert.match(licenseClient, /LICENSE_PROXY_URL = "\/api\/license"/);
  assert.match(licenseClient, /direct Funnel URL/);
  assert.match(licenseProxy, /bodyParser: false/);
  assert.match(licenseProxy, /MAX_UPSTREAM_ATTEMPTS = 2/);
  assert.match(licenseProxy, /requestOverIpv4/);
  assert.match(licenseProxy, /dns\.resolve4/);
  assert.match(licenseProxy, /lookupOptions\?\.all/);
  assert.match(licenseProxy, /family: 4/);
  assert.match(licenseProxy, /The licensing server request timed out/);
});

test("PDF editor can export blank-page-only projects and lets users rename downloads", async () => {
  const shell = await read("components/pdf-editor.jsx");
  const intake = await read("lib/job-intake.js");
  const worker = await read("worker/index.js");
  const filenameField = await read("components/result-filename.jsx");
  assert.match(shell, /Start with blank page/);
  assert.match(shell, /pages\.some\(\(page\) => page\?\.kind === "source"/);
  assert.doesNotMatch(intake, /if \(pdfFiles\.length < 1\) throw new Error\("Add at least one PDF\."\)/);
  assert.match(worker, /manifest\.pdfs\.length > 1 \? "merged" : "blank_pages"/);
  assert.match(await read("scripts/stage-agent-package.mjs"), /staged Local agent still contains the old PDF-editor requirement/);
  assert.match(filenameField, /Download file name/);
  assert.match(await read("components/tool-page.jsx"), /ResultFilenameField/);
  assert.match(await read("components/pdf-text-editor.jsx"), /ResultFilenameField/);
  assert.match(worker, /layoutPdfTextRuns/);
  assert.match(intake, /styled range/);
});

test("PDF result download route accepts a safe custom filename while preserving the extension", async () => {
  const route = await read("pages/api/jobs/[id]/download.js");
  const agent = await read("agent/server.js");
  assert.match(route, /requestedDownloadFilename\(request\.query\.filename, result\.filename\)/);
  assert.match(agent, /requestedDownloadName\(requestedFilename, result\.filename/);
  assert.match(agent, /url\.searchParams\.get\("filename"\)/);
});
