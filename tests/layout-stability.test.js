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

test("tool pages use a shared widget stack with consistent outer spacing", async () => {
  const styles = await read("styles/globals.css");
  const toolShells = [
    "components/tool-page.jsx",
    "components/local-processing-tool-page.jsx",
    "components/svg-to-png-tool.jsx",
    "components/pdf-editor.jsx",
    "components/pdf-text-editor.jsx",
  ];

  for (const file of toolShells) {
    assert.match(await read(file), /className="tool-page-layout"/, `${file} should use the shared widget stack`);
  }

  assert.match(styles, /\.tool-page-layout \{[^}]*display: flex[^}]*flex-direction: column[^}]*gap: 18px/);
  assert.match(styles, /\.tool-page-layout > \* \{[^}]*margin-block-start: 0 !important[^}]*margin-block-end: 0 !important/);
  assert.match(styles, /\.workspace-grid \{[^}]*gap: 18px/);
  assert.match(styles, /\.mock-api-page \{ display: grid; gap: 22px; \}/);
});

test("hamburger navigation exposes all public user-facing route groups", async () => {
  const navigation = await read("components/app-shell.jsx");
  for (const href of [
    "/video-compressor",
    "/audio-extractor",
    "/mock-api",
    "/coming-soon",
    "/guides",
    "/browser-vs-local-agent",
    "/local-agent",
    "/how-to-setup-agent",
    "/offers",
    "/about",
    "/contact",
    "/privacy",
    "/terms",
  ]) {
    assert.match(navigation, new RegExp(`href: "${href}"`), `${href} should be reachable from the hamburger navigation`);
  }
  assert.match(navigation, /aria-label="Resources and support"/);
  assert.doesNotMatch(navigation, /href: "\/api\//);
  assert.doesNotMatch(navigation, /href: "\/downloads\//);
});

test("consent banner keeps a fixed, hidden hydration placeholder", async () => {
  const runtime = await read("components/analytics.jsx");
  const styles = await read("styles/globals.css");

  assert.match(runtime, /analytics-consent-banner \$\{bannerOpen \? "is-open" : "is-hidden"\}/);
  assert.match(runtime, /role="region"/);
  assert.match(runtime, /aria-hidden=\{!bannerOpen\}/);
  assert.match(styles, /\.analytics-consent-banner \{[^}]*position: fixed[^}]*visibility: visible[^}]*opacity: 1/);
  assert.match(styles, /\.analytics-consent-banner\.is-hidden \{[^}]*visibility: hidden[^}]*opacity: 0[^}]*pointer-events: none/);
});
