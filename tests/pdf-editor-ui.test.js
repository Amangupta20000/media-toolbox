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
  assert.match(shell, /const pixelRatio = Math\.min\(3, Math\.max\(2,/);
  assert.match(shell, /const renderViewport = pageInfo\.pdfPage\.getViewport\(\{ scale: scale \* pixelRatio, rotation \}\)/);
  assert.match(shell, /canvas\.style\.width = "100%"/);
  assert.match(previewRoute, /request\.query\.thumbnail === "1" \? "40" : "180"/);
  assert.match(shell, /GlobalWorkerOptions\.workerSrc = "\/api\/pdf\/worker"/);
  assert.match(shell, /const scale = .*previewZoom/);
  assert.match(shell, /surfaceSize/);
  assert.match(workerRoute, /path\.join\(process\.cwd\(\), "node_modules", "pdfjs-dist"/);
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
});

test("PDF result download route accepts a safe custom filename while preserving the extension", async () => {
  const route = await read("pages/api/jobs/[id]/download.js");
  const agent = await read("agent/server.js");
  assert.match(route, /requestedDownloadFilename\(request\.query\.filename, result\.filename\)/);
  assert.match(agent, /requestedDownloadName\(requestedFilename, result\.filename/);
  assert.match(agent, /url\.searchParams\.get\("filename"\)/);
});
