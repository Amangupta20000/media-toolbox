import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (file) => fs.readFile(new URL(file, root), "utf8");

test("PDF compressor is registered as a beta tool and keeps signatures planned", async () => {
  const navigation = await read("components/app-shell.jsx");
  const comingSoon = await read("pages/coming-soon.jsx");
  const route = await read("pages/pdf-compressor.jsx");
  const history = await read("components/tool-history.jsx");
  const intake = await read("lib/job-intake.js");
  const worker = await read("worker/index.js");
  assert.match(navigation, /href: "\/pdf-compressor"[^\n]+beta: true/);
  assert.match(comingSoon, /\["PDF compressor"[^\n]+"Beta", "\/pdf-compressor"\]/);
  assert.match(comingSoon, /\["Sign images & PDFs"[^\n]+PenLine\]/);
  assert.match(route, /ToolPage tool="pdf-compressor"/);
  assert.match(history, /"pdf-compressor": "PDF compression"/);
  assert.match(history, /tool === "pdf-compressor" \? "\/pdf-compressor"/);
  assert.match(intake, /"pdf-compressor"/);
  assert.match(worker, /processPdfCompressor/);
});
