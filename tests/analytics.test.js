import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("GA4 tracking is consent-gated and uses the approved event contract", async () => {
  const analytics = await read("lib/analytics.js");
  const runtime = await read("components/analytics.jsx");
  const app = await read("pages/_app.jsx");
  const privacy = await read("pages/privacy.jsx");
  const environment = await read(".env.example");

  assert.match(environment, /NEXT_PUBLIC_GTM_ID=/);
  assert.match(analytics, /media_toolbox_analytics_consent/);
  assert.match(analytics, /6 \* 30 \* 24 \* 60 \* 60/);
  assert.match(analytics, /ANALYTICS_CONSENT_VERSION/);
  assert.match(analytics, /new Date\(\)\.toISOString\(\)/);
  assert.match(analytics, /getAnalyticsConsent\(\) !== "granted"/);
  assert.match(analytics, /https:\/\/www\.googletagmanager\.com\/gtm\.js/);
  assert.match(analytics, /offer_redeemed: \["offer_id", "result"\]/);
  assert.match(analytics, /custom_page_view: \["page_type", "page_name", "page_title"\]/);
  assert.doesNotMatch(analytics, /page_path/);
  assert.match(analytics, /dataLayer\.push\(\{ event: name/);
  assert.match(runtime, /Accept analytics/);
  assert.match(runtime, /Reject analytics/);
  assert.match(runtime, /Privacy choices/);
  assert.match(runtime, /page category, page name and title/);
  assert.match(runtime, /pageType: "tool", pageName: "svg_to_png"/);
  assert.match(runtime, /pageType: "offer", pageName: "offers"/);
  assert.match(runtime, /pageType: "static_page", pageName: "contact_us"/);
  assert.doesNotMatch(runtime, /page_path/);
  assert.match(runtime, /Google Analytics may also receive standard technical information/);
  assert.match(runtime, /routeChangeComplete/);
  assert.match(runtime, /data-analytics-cta/);
  assert.doesNotMatch(runtime, /<noscript/);
  assert.match(app, /<AnalyticsRuntime \/>/);
  assert.match(privacy, /Google Analytics 4 through Google Tag Manager/);
  assert.match(privacy, /page category, page name and title/);
  assert.doesNotMatch(privacy, /page path and title/);
  assert.match(privacy, /consent-notice version/);
  assert.match(privacy, /Your rights and complaints/);
  assert.match(privacy, /retained for six months/);
});

test("analytics integrations do not expose sensitive input fields", async () => {
  const sources = await Promise.all([
    read("components/tool-page.jsx"),
    read("components/pdf-editor.jsx"),
    read("components/pdf-text-editor.jsx"),
    read("components/svg-to-png-tool.jsx"),
    read("components/offers-page.jsx"),
    read("components/free-access-modal.jsx"),
  ]);
  const trackedCode = sources.join("\n");
  assert.match(trackedCode, /processing_started/);
  assert.match(trackedCode, /processing_completed/);
  assert.match(trackedCode, /result_downloaded/);
  assert.match(trackedCode, /offer_viewed/);
  assert.doesNotMatch(trackedCode, /pushAnalyticsEvent\([^\n]*filename/);
  assert.doesNotMatch(trackedCode, /pushAnalyticsEvent\([^\n]*file\.size/);
  assert.doesNotMatch(trackedCode, /pushAnalyticsEvent\([^\n]*FREE_ACCESS_CODE/);
});
