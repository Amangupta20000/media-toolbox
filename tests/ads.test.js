import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

function count(source, pattern) {
  return source.match(pattern)?.length || 0;
}

function sliceBetween(source, startMarker, endMarker = "") {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

const pageAdStates = [
  { name: "home page", file: "pages/index.jsx", start: "export default function HomePage()", native: 0, responsive: 1 },
  { name: "guides hub", file: "components/approval-guide-page.jsx", start: "export function ApprovalGuidesHub()", native: 1, responsive: 0 },
  { name: "browser versus local-agent guide", file: "components/processing-mode-guide.jsx", start: "export function ProcessingModeGuide()", native: 1, responsive: 0 },
  { name: "setup guide", file: "components/agent-setup-guide.jsx", start: "export function AgentSetupGuide()", native: 1, responsive: 1 },
  { name: "local-agent guide", file: "components/tool-seo-content.jsx", native: 1, responsive: 1 },
  { name: "mock API guide", file: "components/mock-api-page.jsx", native: 1, responsive: 0 },
  { name: "processing options", file: "components/processing-options.jsx", native: 1, responsive: 0 },
  { name: "local processing result", file: "components/local-processing-tool-page.jsx", native: 1, responsive: 0 },
  { name: "PDF editor result and guide", file: "components/pdf-editor.jsx", native: 1, responsive: 1 },
  { name: "PDF text editor result", file: "components/pdf-text-editor.jsx", native: 1, responsive: 0 },
  { name: "single-file result", file: "components/tool-page.jsx", start: "export function JobStatusCard(", end: "function ConversionProgress(", native: 1, responsive: 0 },
  { name: "batch result", file: "components/tool-page.jsx", start: "function BatchJobStatusCard(", end: "function BatchDownloadAction(", native: 1, responsive: 0 },
];

test("each ad widget keeps exactly one provider iframe inside its own labeled wrapper", async () => {
  const native = await read("components/adsterra-native-banner.jsx");
  const responsive = await read("components/adsterra-responsive-banner.jsx");
  const gutter = await read("components/adsterra-gutter-banner.jsx");

  assert.equal(count(native, /<iframe\b/g), 1);
  assert.match(native, /const banner = <aside className="adsterra-native-ad" data-ad-type="native" aria-label="Advertisement">[\s\S]*<iframe[\s\S]*srcDoc=\{adDocument\}/);
  assert.match(native, /createPortal\(banner, mobileDock\)/);
  assert.match(native, /getElementById\("\$\{ADSTERRA_CONTAINER_ID\}"\)[\s\S]*getBoundingClientRect\(\)/);
  assert.match(native, /https:\/\/bauval\.org\/21\/52b2a9d313e02d8d8ea31a538b04248f/);
  assert.match(native, /loading="lazy"/);

  assert.equal(count(responsive, /<iframe\b/g), 1);
  assert.match(responsive, /return <aside className="adsterra-standard-ad" data-ad-type="responsive" aria-label="Advertisement">[\s\S]*\{placement && <iframe[\s\S]*srcDoc=\{adDocument\}/);
  assert.match(responsive, /https:\/\/bauval\.org\/22\/4dded9c08ff44c0a1065bbfc746caf0c/);
  assert.match(responsive, /https:\/\/bauval\.org\/22\/294fa97b1cd4086e19b0d065698254cb/);
  assert.match(responsive, /loading="lazy"/);

  assert.equal(count(gutter, /<iframe\b/g), 1);
  assert.match(gutter, /return <aside className="adsterra-gutter-ad" data-ad-type="gutter" aria-label="Advertisement">[\s\S]*<iframe[\s\S]*srcDoc=\{adDocument\}/);
  assert.match(gutter, /https:\/\/bauval\.org\/22\/15bdc5b2743e8dd55cfed656ec94577c/);
  assert.match(gutter, /width=\{GUTTER_BANNER\.options\.width\} height=\{GUTTER_BANNER\.options\.height\}/);
  assert.match(gutter, /loading="lazy"/);
});

test("each page state has no more than one widget of either ad type", async () => {
  for (const state of pageAdStates) {
    const source = await read(state.file);
    const pageState = sliceBetween(source, state.start || "", state.end);
    const nativeCount = count(pageState, /<AdsterraNativeBanner\s*\/>/g);
    const responsiveCount = count(pageState, /<AdsterraResponsiveBanner\s*\/>/g);

    assert.equal(nativeCount, state.native, `${state.name} native ad placement count`);
    assert.equal(responsiveCount, state.responsive, `${state.name} responsive ad placement count`);
    assert.ok(nativeCount <= 1, `${state.name} must not mount a second native ad widget`);
    assert.ok(responsiveCount <= 1, `${state.name} must not mount a second responsive ad widget`);
  }
});

test("ad widgets reserve layout space and expose a responsive mobile placement", async () => {
  const styles = await read("styles/globals.css");
  const shell = await read("components/app-shell.jsx");

  assert.match(styles, /\.adsterra-native-ad \{[^}]*min-height: 340px/);
  assert.match(styles, /\.adsterra-standard-ad \{[^}]*min-height: 101px/);
  assert.match(styles, /@media \(max-width: 680px\)\s*\{\s*\.adsterra-standard-ad \{ min-height: 91px; \}/);
  assert.match(shell, /id="mobile-native-ad-dock"[\s\S]*<AppFooter \/>/);
  assert.match(styles, /\.mobile-native-ad-dock \{[^}]*display: none/);
  assert.match(styles, /\.mobile-native-ad-dock \{ display: block; width: 100%; padding: 0 14px; \}/);
  assert.match(styles, /\.adsterra-gutter-ad \{[^}]*width: 160px[^}]*min-height: 620px/);
  assert.match(styles, /@media \(min-width: 1240px\) \{ \.adsterra-gutter-ad \{ display: block; \} \}/);
  assert.match(shell, /import \{ AdsterraGutterBanner \} from "\.\/adsterra-gutter-banner\.jsx"/);
  assert.match(shell, /<AppFooter \/>[\s\S]*<\/main>[\s\S]*<AdsterraGutterBanner \/>/);
});

const AD_ROUTES = [
  "/",
  "/pdf-editor",
  "/guides",
  "/browser-vs-local-agent",
  "/local-agent",
  "/how-to-setup-agent",
  "/mock-api",
];

const PAGE_ERROR_MARKERS = [
  /Application error/i,
  /Internal Server Error/i,
  /missing required error components/i,
  /Hydration failed/i,
];

async function fetchWithTimeout(url) {
  return fetch(url, { signal: AbortSignal.timeout(2500) });
}

test("ad-bearing pages return successful HTML without a server or hydration error", async (t) => {
  const baseUrl = (process.env.ADS_TEST_BASE_URL || "http://localhost:3300").replace(/\/$/, "");
  try {
    await fetchWithTimeout(`${baseUrl}/`);
  } catch {
    t.skip(`Live page smoke test skipped: ${baseUrl} is not running. Set ADS_TEST_BASE_URL to a running app URL.`);
    return;
  }

  for (const route of AD_ROUTES) {
    const response = await fetchWithTimeout(`${baseUrl}${route}`);
    const html = await response.text();
    assert.equal(response.status, 200, `${route} should return HTTP 200`);
    for (const marker of PAGE_ERROR_MARKERS) assert.doesNotMatch(html, marker, `${route} should not contain ${marker}`);
  }
});
