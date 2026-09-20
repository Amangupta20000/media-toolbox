import assert from "node:assert/strict";
import test from "node:test";

import { historyReopenMode } from "../components/history-edit.js";

test("PDF history reopens OCR results with the OCR reader", () => {
  assert.equal(historyReopenMode("pdf-text-editor", { reopenMode: "ocr" }), "ocr");
  assert.equal(historyReopenMode("pdf-text-editor", { method: "PDF OCR text editor" }), "ocr");
});

test("PDF history keeps native results on the embedded reader", () => {
  assert.equal(historyReopenMode("pdf-text-editor", { reopenMode: "embedded" }), "embedded");
  assert.equal(historyReopenMode("pdf-text-editor", { method: "PDF text editor" }), "auto");
  assert.equal(historyReopenMode("pdf-editor", { method: "PDF OCR text editor" }), "");
});
