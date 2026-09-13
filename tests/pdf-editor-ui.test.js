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
