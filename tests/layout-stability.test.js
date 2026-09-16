import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("initial tool layout reserves async processing and capability geometry", async () => {
  const processingMode = await read("components/processing-mode.jsx");
  const toolPage = await read("components/tool-page.jsx");
  const styles = await read("styles/globals.css");

  assert.match(processingMode, /const modes = \["local", \.\.\.\(browserAvailable \? \["browser"\] : \[\]\), \.\.\.\(serverAvailable \? \["server"\] : \[\]\)\];/);
  assert.match(processingMode, /className="processing-mode-help" aria-live="polite"/);
  assert.match(toolPage, /className=\{`keep-result-slot \$\{processingMode === "local" \? "visible" : ""\}`\}/);
  assert.match(styles, /\.capability-strip \{[^}]*height: 39px[^}]*overflow: hidden/);
  assert.match(styles, /\.processing-mode-options \{[^}]*grid-template-columns: 1fr/);
  assert.match(styles, /\.processing-mode-help \{[^}]*min-height: 42px/);
  assert.match(styles, /\.keep-result-slot \{[^}]*min-height: 29px/);
});

test("mobile layout uses one shared content gutter without nested width subtraction", async () => {
  const styles = await read("styles/globals.css");

  assert.match(styles, /\.main-area, \.content-wrap, \.breadcrumb-wrap, \.app-footer \{ width: 100%; max-width: 100%; min-width: 0; \}/);
  assert.match(styles, /\.content-wrap \{ padding: 36px 14px 39px; \}/);
  assert.match(styles, /\.content-wrap > \.tool-seo-content,\s*\.content-wrap > \.processing-options-panel \{ width: 100%; max-width: 100%; margin-left: 0; margin-right: 0; \}/);
  assert.doesNotMatch(styles, /\.tool-seo-content, \.breadcrumb-wrap \{ width: calc\(100% - 28px\); \}/);
  assert.doesNotMatch(styles, /\.processing-options-panel \{ width: calc\(100% - 28px\); margin-bottom: 20px; \}/);
});
