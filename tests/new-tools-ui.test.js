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

test("local tools keep their processing behavior while the approval surface is focused", async () => {
  const page = await read("components/local-processing-tool-page.jsx");
  const seo = await read("lib/tool-seo-content.js");
  const processing = await read("components/processing-options.jsx");
  const history = await read("components/tool-history.jsx");
  const navigation = await read("components/app-shell.jsx");
  const comingSoon = await read("pages/coming-soon.jsx");
  for (const tool of ["video-compressor", "audio-extractor"]) {
    assert.equal(browserSupportsTool(tool), false);
    assert.equal(PUBLIC_ROUTES.some((route) => route.path === "/" + tool), false);
    assert.match(page, new RegExp(tool));
    assert.match(seo, new RegExp("\\\"/" + tool + "\\\""));
    assert.match(processing, new RegExp(tool));
    assert.match(history, new RegExp(tool));
    assert.equal(metadataForPathname("/" + tool).noIndex, true);
  }
  assert.equal(PUBLIC_ROUTES.some((route) => route.path === "/pdf-to-images"), true);
  assert.equal(metadataForPathname("/pdf-to-images").noIndex, undefined);
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
  assert.match(page, /const url = hostingMode === "server" \? serverMockApiUrl\(item\.id, endpoint\.path, serverBaseUrlValue\) : localMockApiUrl\(item\.id, endpoint\.path, agentBaseUrlValue\)/);
});

test("Mock API sidebar shows an unsaved draft before it is saved", async () => {
  const page = await read("components/mock-api-page.jsx");
  assert.match(page, /const hasUnsavedDraft = !draft\.endpointId/);
  assert.match(page, /draftName = draft\.name \|\| `\$\{draft\.method\} \$\{draft\.path\}`/);
  assert.match(page, /Unsaved draft/);
  assert.match(page, /onSelectDraft=\{selectDraft\}/);
});

test("Mock API JSON fields use one growing editor with formatting and collapsible nodes", async () => {
  const page = await read("components/mock-api-page.jsx");
  const styles = await read("styles/globals.css");
  assert.match(page, /function JsonBeautifierEditor/);
  assert.match(page, /const projectWithDraft = \(baseProject = project, draftValue = draft\)/);
  assert.match(page, /function collectionForDraft\(endpoints, draft\).*draft\.collection/);
  assert.match(page, /databaseEndpointId: endpoint\.method === "GET" \? endpoint\.id : getEndpoint\?\.id \|\| ""/);
  assert.match(page, /const databaseGetOptions = endpoints\.filter\(\(item\) => item\.method === "GET"\)/);
  assert.match(page, /aria-label="Database GET API"/);
  assert.match(page, /Use data from/);
  assert.match(page, /Its route can be different/);
  assert.match(page, /databaseEndpointId: event\.target\.value/);
  assert.match(page, /function collectionSeedValue\(collection\)/);
  assert.match(page, /const draftSeedIsUnchanged = draft\.method !== "GET" \|\| draft\.seedText === pretty\(collectionSeedValue\(localCollection\)\)/);
  assert.match(page, /JSON config must be an object or an array of objects/);
  assert.match(page, /Use one JSON object or an array of objects/);
  assert.match(page, /Single-record response format/);
  assert.match(page, /When one record matches/);
  assert.match(page, /GET response data/);
  assert.match(page, /GET response node path/);
  assert.match(page, /Return the full matching record/);
  assert.match(page, /Return a specific node/);
  assert.match(page, /Node path <span className="mock-field-hint">Optional<\/span>/);
  assert.match(page, /Leave the node path empty to return the full matching record/);
  assert.match(page, /consentData\.data/);
  assert.match(page, /const listProjects = hostingMode === "server" \? listServerMockProjects : listLocalMockProjects/);
  assert.match(page, /const latestProject = \(await listProjects\(\)\)\.find\(\(item\) => item\.id === project\.id\)/);
  assert.match(page, /saveDraft = \{ \.\.\.draft, seedText: pretty\(collectionSeedValue\(latestCollection\)\) \}/);
  assert.match(page, /function removeEmptyJsonLines/);
  assert.match(page, /filter\(\(line\) => line\.trim\(\) !== ""\)/);
  assert.match(page, /function prettifyJsonText/);
  assert.match(page, /replace\(\/\\n\{2,\}\/g, "\\n"\)/);
  assert.match(page, /function jsonParseErrorMessage/);
  assert.match(page, /const cleanedText = removeEmptyJsonLines\(nextText\)/);
  assert.match(page, /Fix JSON syntax near line \$\{line\}, column \$\{column\}\./);
  assert.match(page, /const codeScrollRef = useRef\(null\)/);
  assert.match(page, /const scrollRestoreRef = useRef\(null\)/);
  assert.match(page, /window\.scrollTo\(snapshot\.pageX, snapshot\.pageY\)/);
  assert.match(page, /codeScrollRef\.current\.scrollTop = snapshot\.containerTop/);
  assert.match(page, /ref=\{codeScrollRef\} className="json-beautifier-code-scroll"/);
  assert.match(page, />Prettify<\/button>/);
  assert.match(page, />Level 1<\/button>/);
  assert.match(page, />Level 2<\/button>/);
  assert.match(page, />Level 3<\/button>/);
  assert.doesNotMatch(page, /title="Collapse to level [123]"[^>]*disabled=\{!isValid\}/);
  assert.doesNotMatch(page, />Expand<\/button>[^<]*disabled=\{!isValid\}/);
  assert.match(page, /json-beautifier-toolbar/);
  assert.match(page, /json-beautifier-code-input/);
  assert.match(page, /function jsonNestingDepth/);
  assert.match(page, /function buildJsonFolds/);
  assert.match(page, /function remapJsonFoldKeys/);
  assert.match(page, /lastValidFoldsRef/);
  assert.match(page, /Keep the current folds while the user is between valid JSON states/);
  assert.match(page, /closeIndex: index/);
  assert.match(page, /function collapsedJsonLine/);
  assert.match(page, /\$\{prefix\}\$\{fold\.open\}\.\.\./);
  assert.match(page, /countLabel/);
  assert.match(page, /json-token-comment/);
  assert.match(page, /onKeyDown=\{handleKeyDown\}/);
  assert.match(page, /json-beautifier-gutter/);
  assert.doesNotMatch(page, /function JsonTreeNode/);
  assert.doesNotMatch(page, />Editor<\/button>/);
  assert.match(page, /onPaste=\{handlePaste\}/);
  assert.match(page, /function pastedJsonText/);
  assert.match(page, /event\.key !== "Enter"/);
  assert.match(page, /jsonNestingDepth\(text\.slice\(0, start\)\)/);
  assert.match(page, /useLayoutEffect\(\(\) =>/);
  assert.match(page, /pendingSelectionRef\.current = \{ start: event\.target\.selectionStart, end: event\.target\.selectionEnd \}/);
  assert.match(page, /const highlightRef = useRef\(null\)/);
  assert.match(page, /handleEditorMouseUp/);
  assert.match(page, /document\.caretPositionFromPoint/);
  assert.match(page, /data-line-index=\{index\}/);
  assert.match(page, /json-beautifier-line-number/);
  assert.match(page, /\{index \+ 1\}/);
  assert.match(page, /json-beautifier-fold-placeholder/);
  assert.match(page, /const isFoldedView = collapsedFoldKeys\.size > 0/);
  assert.match(page, /handleFoldedViewClick/);
  assert.match(page, /const collapsedFold = collapsedFoldByLine\.get\(lineIndex\)/);
  assert.match(page, /const renderedLines = \[\.\.\.highlight\.querySelectorAll/);
  assert.match(page, /event\.target\.closest\?\.\("\.json-beautifier-code-line"\)/);
  assert.match(page, /const fallbackLineIndex = Math\.max\(0, Math\.min\(renderedLines\.length - 1/);
  assert.match(page, /const visibleLineIndex = renderedLines\.indexOf\(line\)/);
  assert.match(page, /const editorScrollTop = Math\.max\(0, \(targetLineIndex - visibleLineIndex\) \* lineHeight\)/);
  assert.match(page, /scrollContainer\.scrollTop = previousScrollTop/);
  assert.match(page, /editor\.setSelectionRange\(documentOffset, documentOffset\)/);
  assert.doesNotMatch(page, /onChange\(prettifyJsonText\(nextText\)\); setCollapsedFolds\(new Set\(\)\)/);
  assert.doesNotMatch(page, /handleFoldedViewClick = \(event\) => \{ if \(!isFoldedView \|\| event\.target\.closest\("button"\)\) return; setCollapsedFolds\(new Set\(\)\); \}/);
  assert.match(page, /json-beautifier-code-input-folded/);
  assert.match(page, /visibleLines\.length \* lineHeight/);
  assert.match(page, /height: `\$\{editorHeight\}px`/);
  assert.match(styles, /\.json-beautifier-textarea[^\n]*max-height: 75vh/);
  assert.match(styles, /\.json-beautifier-tree[^\n]*max-height: 75vh/);
  assert.match(styles, /\.json-beautifier-code-scroll[^\n]*max-height: 75vh/);
  assert.match(styles, /\.json-beautifier-code-input-folded[^\n]*pointer-events: none/);
  assert.match(styles, /\.json-beautifier-line-number[^\n]*font-variant-numeric/);
  assert.match(styles, /\.json-beautifier-fold-placeholder/);
  assert.match(styles, /\.json-beautifier-highlight[^\n]*pointer-events: auto/);
  assert.match(styles, /\.json-token-comment[^\n]*color: #777/);
  assert.match(styles, /\.json-beautifier-toolbar[^\n]*position: absolute/);
  assert.match(styles, /\.json-beautifier-toolbar[^\n]*z-index: 5/);
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

test("Mock API guided POST builder derives and stores internal update actions", async () => {
  const page = await read("components/mock-api-page.jsx");
  assert.match(page, /function PostActionBuilder/);
  assert.match(page, /aria-label="POST behavior"/);
  assert.match(page, /Update existing records/);
  assert.doesNotMatch(page, /aria-label="POST update collection"/);
  assert.match(page, /aria-label="POST update operation"/);
  assert.match(page, /Add values to an array/);
  assert.match(page, /aria-label="POST append array"/);
  assert.match(page, /ariaLabel="POST append request source"/);
  assert.match(page, /aria-label="POST record match field"/);
  assert.match(page, /aria-label="POST nested array"/);
  assert.match(page, /ariaLabel="POST item request source"/);
  assert.match(page, /aria-label="POST update field"/);
  assert.match(page, /function buildPostActionFromDraft/);
  assert.match(page, /const postAction = databaseMode && draftValue\.method === "POST"/);
  assert.match(page, /postAction \? \{ postAction \} : \{\}/);
  assert.match(page, /postActions !== true/);
  assert.doesNotMatch(page, /aria-label="POST action JSON editor"/);
});

test("Mock API headers use Postman-style key/value rows", async () => {
  const page = await read("components/mock-api-page.jsx");
  const styles = await read("styles/globals.css");
  assert.match(page, /function HeaderRowsEditor/);
  assert.match(page, /HeaderRowsEditor label="Success headers"/);
  assert.match(page, /HeaderRowsEditor label="Error headers"/);
  assert.match(page, /if \(\/headers\/i\.test\(props\.label\)\) return <HeaderRowsEditor/);
  assert.match(page, /function RequestInputTabs/);
  assert.match(page, /role="tablist" aria-label="Request input tabs"/);
  assert.match(page, />Body<\/button>/);
  assert.match(page, />Headers<\/button>/);
  assert.match(page, /HeaderRowsEditor label="Request headers"/);
  assert.match(page, /aria-label=\{`Header key \$\{index \+ 1\}`\}/);
  assert.match(page, /aria-label=\{`Header value \$\{index \+ 1\}`\}/);
  assert.match(page, /> Add header</);
  assert.match(page, /headersTextFromRows/);
  assert.match(page, /const handleRemoveKeyDown = \(event, index\) =>/);
  assert.match(page, /event\.key !== "Tab"/);
  assert.match(page, /window\.requestAnimationFrame\(\(\) => controlRefs\.current/);
  assert.match(styles, /\.mock-headers-table/);
  assert.match(styles, /\.mock-header-row > input\[type="text"\]/);
});

test("Mock API guides database PUT, PATCH, and DELETE record routes", async () => {
  const page = await read("components/mock-api-page.jsx");
  assert.match(page, /const recordMethods = \["PUT", "PATCH", "DELETE"\]/);
  assert.match(page, /Replaces the complete record addressed by the final :id path segment/);
  assert.match(page, /Updates only the fields included in the request body/);
  assert.match(page, /Deletes the record addressed by the final :id path segment/);
  assert.match(page, /placeholder=\{recordMethod \? "\/users\/:id" : "\/users"\}/);
  assert.match(page, /mock-crud-method-note/);
});

test("Mock API feedback banners dismiss after five seconds", async () => {
  const page = await read("components/mock-api-page.jsx");
  assert.match(page, /const timeout = window\.setTimeout\(\(\) => setNotice\(""\), 5000\)/);
  assert.match(page, /const timeout = window\.setTimeout\(\(\) => setError\(""\), 5000\)/);
  assert.match(page, /return \(\) => window\.clearTimeout\(timeout\)/);
});

test("Mock API lets users choose Server or Local agent hosting", async () => {
  const page = await read("components/mock-api-page.jsx");
  const client = await read("components/mock-api-client.js");
  assert.match(page, /aria-label="Mock API hosting mode"/);
  assert.match(page, /<option value="server">Server<\/option>/);
  assert.match(page, /<option value="local">Local agent<\/option>/);
  assert.match(page, /onHostingModeChange=\{setHostingMode\}/);
  assert.match(page, /saveServerMockProject/);
  assert.match(page, /simulateServerMockRequest/);
  assert.match(client, /export function serverMockApiUrl/);
  assert.match(client, /export async function saveServerMockProject/);
});

test("Mock API highlights the Simulate workspace tab", async () => {
  const page = await read("components/mock-api-page.jsx");
  const styles = await read("styles/globals.css");
  assert.match(page, /className=\{`simulate-tab\$\{workspaceTab === "simulate" \? " active" : ""\}`\}/);
  assert.match(page, /<span className="simulate-tab-label">Simulate<\/span>/);
  assert.match(styles, /\.mock-workspace-tabs \.simulate-tab-label \{[^}]*animation: mock-simulate-text-shimmer 1\.8s linear infinite;/);
  assert.match(styles, /@keyframes mock-simulate-text-shimmer/);
  assert.match(styles, /prefers-reduced-motion: reduce\) \{ \.mock-workspace-tabs \.simulate-tab-label \{ animation: none;/);
});

test("Mock API derives collections from GET routes instead of the users fallback", async () => {
  const page = await read("components/mock-api-page.jsx");
  assert.match(page, /function repairDefaultCollection/);
  assert.match(page, /function repairDraftCollection/);
  assert.match(page, /if \(draft\.method === "GET" && draft\.collectionAuto !== false\)/);
  assert.match(page, /if \(key === "path" && draft\.method === "GET" && draft\.collectionAuto !== false\) nextDraft\.collection = collectionFromPath\(value\)/);
  assert.match(page, /const usedCollections = new Set\(nextEndpoints\.map\(\(item\) => item\.collection\)\.filter\(Boolean\)\)/);
});
