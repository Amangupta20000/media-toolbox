import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (file) => fs.readFile(new URL(file, root), "utf8");

test("PDF compressor is available and is not listed as coming soon", async () => {
  const navigation = await read("components/app-shell.jsx");
  const comingSoon = await read("pages/coming-soon.jsx");
  const route = await read("pages/pdf-compressor.jsx");
  const toolPage = await read("components/tool-page.jsx");
  const history = await read("components/tool-history.jsx");
  const intake = await read("lib/job-intake.js");
  const worker = await read("worker/index.js");
  assert.match(history, /tool !== "pdf-compressor" && <button className="secondary-button" type="button" onClick=\{onEdit\}/);
  assert.match(navigation, /href: "\/pdf-compressor"[^\n]+icon: Archive \}/);
  assert.doesNotMatch(navigation, /href: "\/pdf-compressor"[^\n]+beta: true/);
  assert.doesNotMatch(comingSoon, /\["PDF compressor"/);
  assert.match(comingSoon, /\["Sign images & PDFs"[^\n]+PenLine\]/);
  assert.match(route, /ToolPage tool="pdf-compressor"/);
  assert.match(toolPage, /pdf-custom-quality/);
  assert.match(toolPage, /pdf-custom-target/);
  assert.match(toolPage, /Estimated new file size/);
  assert.match(history, /"pdf-compressor": "PDF compression"/);
  assert.match(history, /tool === "pdf-compressor" \? "\/pdf-compressor"/);
  assert.match(intake, /"pdf-compressor"/);
  assert.match(intake, /"custom"/);
  assert.match(worker, /customQuality/);
  assert.match(worker, /targetBytes/);
  assert.match(worker, /removeColor/);
  assert.match(worker, /processPdfCompressor/);
});
