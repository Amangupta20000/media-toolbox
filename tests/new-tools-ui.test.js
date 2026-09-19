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

test("Mock API separates new-project and new-API actions", async () => {
  const page = await read("components/mock-api-page.jsx");
  assert.match(page, /title="Create a new project"/);
  assert.match(page, /title="Create a new API"/);
  assert.match(page, /title=\{`Delete \$\{endpoint\.name\}`\}/);
  assert.match(page, /onDeleteEndpoint=\{deleteEndpoint\}/);
  assert.match(page, /onNewProject=\{newProject\}/);
  assert.match(page, /const newProject = \(\) =>/);
});

test("Mock API keeps collection terminology out of the workspace copy", async () => {
  const page = await read("components/mock-api-page.jsx");
  assert.doesNotMatch(page, /route name becomes the collection name/);
  assert.doesNotMatch(page, /lightweight Postman collection/);
  assert.match(page, /\$\{projectCollections\(item\)\.length\} collection/);
});

test("Mock API history exposes endpoint-level actions", async () => {
  const page = await read("components/mock-api-page.jsx");
  assert.match(page, /<details className="mock-history-item"/);
  assert.match(page, /const itemEndpoints = projectEndpoints\(item\)/);
  assert.match(page, /onClick=\{\(\) => editHistoryEndpoint\(item, endpoint\.id\)\}/);
  assert.match(page, /onClick=\{\(\) => simulateHistoryEndpoint\(item, endpoint\.id\)\}/);
  assert.match(page, /onClick=\{\(\) => deleteHistoryEndpoint\(item, endpoint\.id\)\}/);
  assert.match(page, /const url = localMockApiUrl\(item\.id, endpoint\.path, agentBaseUrlValue\)/);
});

test("Mock API sidebar shows an unsaved draft before it is saved", async () => {
  const page = await read("components/mock-api-page.jsx");
  assert.match(page, /const hasUnsavedDraft = !draft\.endpointId/);
  assert.match(page, /draftName = draft\.name \|\| `\$\{draft\.method\} \$\{draft\.path\}`/);
  assert.match(page, /Unsaved draft/);
  assert.match(page, /onSelectDraft=\{selectDraft\}/);
});

test("Mock API JSON fields use a growing beautifier and collapsible node view", async () => {
  const page = await read("components/mock-api-page.jsx");
  const styles = await read("styles/globals.css");
  assert.match(page, /function JsonBeautifierEditor/);
  assert.match(page, />Prettify<\/button>/);
  assert.match(page, />Close 1<\/button>/);
  assert.match(page, />Close 2<\/button>/);
  assert.match(page, />Close 3<\/button>/);
  assert.match(page, />Node view<\/button>/);
  assert.match(page, /onPaste=\{handlePaste\}/);
  assert.match(page, /height: `min\(/);
  assert.match(styles, /\.json-beautifier-textarea[^\n]*max-height: 75vh/);
  assert.match(styles, /\.json-beautifier-tree[^\n]*max-height: 75vh/);
});

test("Mock API URLs use a hydration-safe initial transport", async () => {
  const page = await read("components/mock-api-page.jsx");
  const client = await read("components/mock-api-client.js");
  assert.match(page, /useState\("http:\/\/127\.0\.0\.1:4789"\)/);
  assert.match(page, /setAgentBaseUrlValue\(agentBaseUrl\(\)\)/);
  assert.match(page, /agentBaseUrlValue=\{agentBaseUrlValue\}/);
  assert.match(client, /baseUrl = agentBaseUrl\(\)/);
  assert.ok(client.includes('String(baseUrl).replace(/\\/$/, "")'));
});
