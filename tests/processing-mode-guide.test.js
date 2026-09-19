import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PROCESSING_MODE_GUIDE } from "../lib/processing-mode-guide.js";
import { metadataForPathname, PUBLIC_ROUTES } from "../lib/site-metadata.js";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("Browser vs Local agent guide has stable navigable sections and route SEO", async () => {
  const page = await read("pages/browser-vs-local-agent.jsx");
  const component = await read("components/processing-mode-guide.jsx");
  const styles = await read("styles/globals.css");
  const ids = PROCESSING_MODE_GUIDE.navigation.map(([id]) => id);

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["overview", "comparison", "choose", "tool-comparison", "how-it-works", "faq", "start"]);
  assert.ok(PUBLIC_ROUTES.some(({ path: route }) => route === "/browser-vs-local-agent"));
  assert.equal(metadataForPathname("/browser-vs-local-agent").breadcrumbLabel, "Browser vs Local agent");
  assert.match(page, /ProcessingModeGuide/);
  assert.match(component, /<article className="mode-guide-page">/);
  assert.match(component, /<h1>Browser Mode vs Local Agent<\/h1>/);
  assert.match(component, /Written by <strong>\{AUTHOR_NAME\}<\/strong>/);
  assert.match(component, /aria-label="On this page"/);
  assert.match(component, /<a href=\{`#\$\{id\}`\} title=\{label\}/);
  assert.match(component, /<Link href=\{tool\.href\} title=\{`Open \$\{tool\.name\}`\}/);
  for (const id of ids) assert.match(component, new RegExp(`id="${id}"`));
  assert.match(component, /IntersectionObserver/);
  assert.match(component, /<svg viewBox="0 0 960 310"/);
  assert.match(styles, /\.mode-guide-flow-line-browser/);
  assert.match(styles, /\.mode-guide-toc-links/);
  assert.match(styles, /\.mode-guide-tool-table/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(component, /BlogPosting/);
});

test("guide limits and FAQs are sourced from current processing facts", () => {
  const toolNames = PROCESSING_MODE_GUIDE.tools.map((tool) => tool.name);
  assert.deepEqual(toolNames, ["Image converter", "SVG to PNG", "PDF editor", "PDF text editor", "PDF compressor", "Video repair", "Video compressor", "Audio extractor", "PDF to images"]);
  assert.match(PROCESSING_MODE_GUIDE.tools[0].browser, /5 MB per image/);
  assert.match(PROCESSING_MODE_GUIDE.tools[2].browser, /5 PDFs and 50 MB total/);
  assert.match(PROCESSING_MODE_GUIDE.tools[3].browser, /25 MB and 100 pages/);
  assert.match(PROCESSING_MODE_GUIDE.tools[4].browser, /10 MB and 100 pages/);
  assert.equal(PROCESSING_MODE_GUIDE.tools[5].browser, "Not available; repair needs native recovery tools.");
  assert.equal(PROCESSING_MODE_GUIDE.tools[6].browser, "Not available; compression uses native FFmpeg processing.");
  assert.equal(PROCESSING_MODE_GUIDE.tools[7].browser, "Not available; extraction uses native FFmpeg processing.");
  assert.equal(PROCESSING_MODE_GUIDE.tools[8].browser, "Not available; PDF page rendering requires the Local agent.");
  assert.equal(PROCESSING_MODE_GUIDE.faqs.length, 10);
  assert.equal(new Set(PROCESSING_MODE_GUIDE.faqs.map(([question]) => question)).size, 10);
});
