import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { normalizeSvgMarkup, normalizeSvgOptions, validateSvgMarkup } from "../lib/svg-options.js";
import { metadataForPathname, PUBLIC_ROUTES } from "../lib/site-metadata.js";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("SVG to PNG is exposed as a tool with crawlable SEO metadata", async () => {
  const shell = await read("components/app-shell.jsx");
  const route = await read("pages/svg-to-png/index.jsx");
  const tool = await read("components/svg-to-png-tool.jsx");
  const comingSoon = await read("pages/coming-soon.jsx");
  const seo = await read("lib/site-metadata.js");
  const content = await read("lib/tool-seo-content.js");

  assert.match(shell, /href: "\/svg-to-png", label: "SVG to PNG"/);
  assert.doesNotMatch(shell, /href: "\/svg-to-png"[^\n]+beta: true/);
  assert.match(route, /SvgToPngTool/);
  assert.match(tool, /Convert an SVG file or paste SVG code/);
  assert.match(tool, /1×/);
  assert.match(tool, /2×/);
  assert.match(tool, /3×/);
  assert.match(tool, /4×/);
  assert.match(tool, /backgroundColor/);
  assert.doesNotMatch(tool, /<span className="beta-label">Beta<\/span>/);
  assert.doesNotMatch(tool, /<span className="optional-label">Beta<\/span>/);
  assert.match(tool, /Gradient/);
  assert.match(tool, /Background opacity/);
  assert.match(tool, /Keep aspect ratio/);
  assert.match(tool, /Live PNG preview/);
  assert.match(tool, /const \[livePreviewUrl, setLivePreviewUrl\]/);
  assert.match(tool, /processBrowserSvg\(source, options\)/);
  assert.match(tool, /const customScaleAvailable = processingMode !== "browser";/);
  assert.match(tool, /Custom SVG size is unavailable in Browser mode/);
  assert.match(tool, /<LockKeyhole size=\{10\} aria-hidden="true" \/> Local agent only/);
  assert.match(tool, /processingMode === "browser" && scale === "custom"/);
  assert.match(tool, /const processingReady = isProcessingLocationReady\(locations, processingMode\);/);
  assert.match(tool, /disabled=\{busy \|\| !source \|\| !processingReady\}/);
  assert.match(tool, /getProcessingJob\(jobMode, jobId\)/);
  assert.match(tool, /setJobMode\(processingMode\)/);
  assert.match(tool, /Browser conversion started\./);
  assert.match(tool, /logs: appendLog\(current\.logs, message \|\| "Processing"\)/);
  assert.match(tool, /onPaste=\{handleCodePaste\}/);
  assert.match(tool, /onBlur=\{handleCodeBlur\}/);
  assert.doesNotMatch(tool, /Use pasted SVG/);
  assert.match(tool, /ToolFaqContent pathname="\/svg-to-png"/);
  assert.doesNotMatch(comingSoon, /\["SVG to PNG converter"/);
  assert.match(seo, /"\/svg-to-png": \{/);
  assert.match(content, /"\/svg-to-png": \{/);
  assert.ok(PUBLIC_ROUTES.some(({ path: routePath }) => routePath === "/svg-to-png"));
  assert.match(metadataForPathname("/svg-to-png").title, /SVG to PNG Converter/);
  assert.ok(metadataForPathname("/svg-to-png").description.length >= 120);
});

test("SVG options and markup validation keep conversion local and bounded", async () => {
  assert.deepEqual(normalizeSvgOptions({ scale: "4", background: "transparent", backgroundColor: "#ffffff" }), { scale: "4", background: "transparent", backgroundColor: "#ffffff", backgroundOpacity: 100, gradientStartColor: "#ffffff", gradientEndColor: "#d9f3f1", gradientAngle: 135, preserveAspectRatio: true });
  assert.deepEqual(normalizeSvgOptions({ scale: "custom", width: "1200", height: "800", background: "color", backgroundColor: "#123ABC", backgroundOpacity: "72", preserveAspectRatio: false }), { scale: "custom", width: 1200, height: 800, background: "color", backgroundColor: "#123abc", backgroundOpacity: 72, gradientStartColor: "#ffffff", gradientEndColor: "#d9f3f1", gradientAngle: 135, preserveAspectRatio: false });
  assert.deepEqual(normalizeSvgOptions({ scale: "1", background: "gradient", gradientStartColor: "#FF0000", gradientEndColor: "#00ff00", gradientAngle: "45", backgroundOpacity: "60" }), { scale: "1", background: "gradient", backgroundColor: "#ffffff", backgroundOpacity: 60, gradientStartColor: "#ff0000", gradientEndColor: "#00ff00", gradientAngle: 45, preserveAspectRatio: true });
  assert.throws(() => normalizeSvgOptions({ scale: "custom", width: "0", height: "800" }), /Custom width/);
  assert.throws(() => normalizeSvgOptions({ background: "gradient", backgroundOpacity: "101" }), /opacity/);
  assert.throws(() => normalizeSvgOptions({ background: "gradient", gradientAngle: "361" }), /direction/);
  assert.equal(validateSvgMarkup(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" /></svg>`).startsWith("<svg"), true);
  assert.match(normalizeSvgMarkup(`<svg width="100" height="100"><circle cx="50" cy="50" r="40" /></svg>`), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(normalizeSvgMarkup(`<svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>`), `<svg xmlns="http://www.w3.org/2000/svg"><circle /></svg>`);
  assert.throws(() => validateSvgMarkup("<svg><script>alert(1)</script></svg>"), /active or embedded/);
  assert.throws(() => validateSvgMarkup("<svg><image href=\"https://example.com/a.png\" /></svg>"), /external/);
  const browserProcessing = await read("components/browser-processing.js");
  assert.match(browserProcessing, /onProgress\?\.\(55, `Rendering SVG at \$\{width\} × \$\{height\}`\)/);
  assert.match(browserProcessing, /onProgress\?\.\(90, "Creating PNG output"\)/);
  assert.match(browserProcessing, /createLinearGradient/);
  assert.match(browserProcessing, /backgroundOpacity/);
  const worker = await read("worker/index.js");
  assert.match(worker, /svgBackgroundMarkup/);
  assert.match(worker, /preserveAspectRatio === false/);
});
