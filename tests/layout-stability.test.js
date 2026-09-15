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

  assert.match(processingMode, /const modes = \["local", "server"\];/);
  assert.match(processingMode, /className="processing-mode-help" aria-live="polite"/);
  assert.match(toolPage, /className=\{`keep-result-slot \$\{processingMode === "local" \? "visible" : ""\}`\}/);
  assert.match(styles, /\.capability-strip \{[^}]*height: 39px[^}]*overflow: hidden/);
  assert.match(styles, /\.processing-mode-options \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.processing-mode-help \{[^}]*min-height: 42px/);
  assert.match(styles, /\.keep-result-slot \{[^}]*min-height: 29px/);
});
