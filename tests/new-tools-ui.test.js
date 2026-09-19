import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { browserSupportsTool } from "../components/browser-processing.js";
import { metadataForPathname, PUBLIC_ROUTES } from "../lib/site-metadata.js";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("new local tools are routed, indexable, and excluded from Browser mode", async () => {
  const page = await read("components/local-processing-tool-page.jsx");
  const seo = await read("lib/tool-seo-content.js");
  const processing = await read("components/processing-options.jsx");
  const history = await read("components/tool-history.jsx");
  const navigation = await read("components/app-shell.jsx");
  const comingSoon = await read("pages/coming-soon.jsx");
  for (const tool of ["video-compressor", "audio-extractor", "pdf-to-images"]) {
    assert.equal(browserSupportsTool(tool), false);
    assert.equal(PUBLIC_ROUTES.some((route) => route.path === "/" + tool), true);
    assert.match(page, new RegExp(tool));
    assert.match(seo, new RegExp("\\\"/" + tool + "\\\""));
    assert.match(processing, new RegExp(tool));
    assert.match(history, new RegExp(tool));
    assert.equal(metadataForPathname("/" + tool).noIndex, undefined);
  }
  assert.match(page, /ToolHistory tool=\{tool\}/);
  assert.match(page, /ToolFaqContent pathname=\{\"\/\" \+ tool\}/);
  assert.match(page, /Keep final result on this device/);
  assert.match(page, /media-toolbox-active-job/);
  assert.match(page, /Restoring the job after this page was reloaded/);
  assert.match(page, /deleteProcessingJob\(jobMode, jobId\)/);
  assert.match(page, /mediaType = "Video"/);
  assert.match(page, /Based on video time/);
  assert.match(page, /mediaType === "Audio" \? "extraction"/);
  assert.match(page, /Video to audio converter/);
  assert.match(page, /adminUrlAccess/);
  assert.match(page, /media-toolbox-admin-auth/);
  assert.match(page, /Admin media URL/);
  assert.doesNotMatch(page, /yt-dlp/i);
  assert.doesNotMatch(seo, /yt-dlp/i);
  assert.match(seo, /Convert video to audio files/);
  assert.doesNotMatch(seo, /public media URL|media URL|public media downloader/i);
  assert.doesNotMatch(seo, /Which sites are supported\?/);
  assert.match(page, /authenticated Admin session/);
  assert.match(comingSoon, /\["Audio extractor"[\s\S]*"Beta"[\s\S]*"\/audio-extractor"/);
  assert.doesNotMatch(comingSoon, /\["Video compressor"/);
  assert.doesNotMatch(comingSoon, /\["PDF to images"/);
  assert.doesNotMatch(navigation, /href: "\/video-compressor"[^\n]+beta: true/);
  assert.doesNotMatch(navigation, /href: "\/pdf-to-images"[^\n]+beta: true/);
});
