import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { browserSupportsTool } from "../components/browser-processing.js";
import { metadataForPathname } from "../lib/site-metadata.js";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("video repair explains its Local-agent workflow and recovery limits", async () => {
  const page = await read("components/tool-page.jsx");
  const content = await read("lib/tool-seo-content.js");
  const processingOptions = await read("components/processing-options.jsx");
  const metadata = metadataForPathname("/video-repair");

  assert.equal(browserSupportsTool("video-repair"), false);
  assert.match(page, /Repair damaged MP4, MOV, and video files locally/);
  assert.match(page, /Video repair runs on the Local agent/);
  assert.match(page, /Browser mode is not available for this tool/);
  assert.match(page, /videos up to 2 GB/);
  assert.match(page, /same resolution, frame rate, codec, and recording settings/);
  assert.match(page, /View the setup guide/);
  assert.match(page, /Original stays untouched/);
  assert.match(page, /formatDuration/);
  assert.match(page, /<span>Duration<\/span>/);
  assert.match(content, /video repair tool runs on the Local agent/);
  assert.match(content, /What should match in the reference video/);
  assert.match(content, /shorter or missing frames/);
  assert.match(content, /Keep the original until you have verified the recovered video/);
  assert.match(processingOptions, /Not supported — video repair requires the Local agent/);
  assert.match(metadata.title, /Repair Damaged Video Files Locally/);
  assert.match(metadata.description, /Browser mode is unavailable/);
  assert.match(metadata.keywords, /repair corrupted video/);
});
