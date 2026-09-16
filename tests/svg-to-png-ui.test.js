import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { normalizeSvgOptions, validateSvgMarkup } from "../lib/svg-options.js";
import { metadataForPathname, PUBLIC_ROUTES } from "../lib/site-metadata.js";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("SVG to PNG is exposed as a beta tool with crawlable SEO metadata", async () => {
  const shell = await read("components/app-shell.jsx");
  const route = await read("pages/svg-to-png/index.jsx");
  const tool = await read("components/svg-to-png-tool.jsx");
  const comingSoon = await read("pages/coming-soon.jsx");
  const seo = await read("lib/site-metadata.js");
  const content = await read("lib/tool-seo-content.js");

  assert.match(shell, /href: "\/svg-to-png", label: "SVG to PNG"/);
  assert.match(shell, /href: "\/svg-to-png"[^\n]+beta: true/);
  assert.match(route, /SvgToPngTool/);
  assert.match(tool, /Upload an SVG or paste its code/);
  assert.match(tool, /1×/);
  assert.match(tool, /2×/);
  assert.match(tool, /3×/);
  assert.match(tool, /4×/);
  assert.match(tool, /backgroundColor/);
  assert.match(tool, /const processingReady = isProcessingLocationReady\(locations, processingMode\);/);
  assert.match(tool, /disabled=\{busy \|\| !source \|\| !processingReady\}/);
  assert.match(tool, /getProcessingJob\(jobMode, jobId\)/);
  assert.match(tool, /setJobMode\(processingMode\)/);
  assert.match(tool, /ToolFaqContent pathname="\/svg-to-png"/);
  assert.doesNotMatch(comingSoon, /\["SVG to PNG converter"/);
  assert.match(seo, /"\/svg-to-png": \{/);
  assert.match(content, /"\/svg-to-png": \{/);
  assert.ok(PUBLIC_ROUTES.some(({ path: routePath }) => routePath === "/svg-to-png"));
  assert.match(metadataForPathname("/svg-to-png").title, /SVG to PNG Converter/);
  assert.ok(metadataForPathname("/svg-to-png").description.length >= 120);
});

test("SVG options and markup validation keep conversion local and bounded", () => {
  assert.deepEqual(normalizeSvgOptions({ scale: "4", background: "transparent", backgroundColor: "#ffffff" }), { scale: "4", background: "transparent", backgroundColor: "#ffffff" });
  assert.deepEqual(normalizeSvgOptions({ scale: "custom", width: "1200", height: "800", background: "color", backgroundColor: "#123ABC" }), { scale: "custom", width: 1200, height: 800, background: "color", backgroundColor: "#123abc" });
  assert.throws(() => normalizeSvgOptions({ scale: "custom", width: "0", height: "800" }), /Custom width/);
  assert.equal(validateSvgMarkup(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>`).startsWith("<svg"), true);
  assert.throws(() => validateSvgMarkup("<svg><script>alert(1)</script></svg>"), /active or embedded/);
  assert.throws(() => validateSvgMarkup("<svg><image href=\"https://example.com/a.png\" /></svg>"), /external/);
});
