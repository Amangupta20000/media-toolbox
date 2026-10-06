import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { APPROVAL_GUIDES } from "../lib/approval-guides.js";
import { PROCESSING_MODE_GUIDE } from "../lib/processing-mode-guide.js";
import { ADSENSE_CLIENT_ID, APPROVAL_ROUTE_PATHS, DEFERRED_ROUTES, INSTALLER_ROUTES, PUBLIC_ROUTES, ROUTE_LAST_MODIFIED, SITE_URL } from "../lib/site-metadata.js";
import { TOOL_SEO_CONTENT } from "../lib/tool-seo-content.js";

const port = Number(process.env.SEO_PORT || 4173);
const baseUrl = (process.env.SEO_BASE_URL || "http://127.0.0.1:" + port).replace(/\/$/, "");
const shouldStartServer = !process.env.SEO_BASE_URL;
let server;

function htmlMeta(html, name) {
  const pattern = new RegExp("<meta[^>]+(?:name|property)=[\"']" + name + "[\"'][^>]+content=[\"']([^\"']*)[\"']", "i");
  return html.match(pattern)?.[1] || "";
}

function canonical(html) {
  return html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']*)["']/i)?.[1] || "";
}

function title(html) {
  return html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || "";
}

function h1(html) {
  return html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "";
}

function countAdSense(html) {
  const source = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + ADSENSE_CLIENT_ID;
  return html.split(source).length - 1;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(baseUrl + "/");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Production server did not start at " + baseUrl);
}

async function fetchText(pathname) {
  const response = await fetch(baseUrl + pathname);
  const body = await response.text();
  assert.equal(response.status, 200, pathname + " returned " + response.status);
  return body;
}

async function verify() {
  if (shouldStartServer) {
    assert.ok(existsSync(".next/standalone/server.js"), "Run npm run build before the production SEO check");
    server = spawn(process.execPath, [".next/standalone/server.js"], {
      env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1" },
      stdio: "ignore",
    });
    await waitForServer();
  }

  const titles = new Map();
  const descriptions = new Map();
  const canonicals = new Map();
  for (const pathname of APPROVAL_ROUTE_PATHS) {
    const html = await fetchText(pathname);
    const pageTitle = title(html);
    const description = htmlMeta(html, "description");
    const pageCanonical = canonical(html);
    const pageHeading = h1(html);
    assert.ok(pageTitle, pathname + " is missing a title");
    assert.ok(description, pathname + " is missing a description");
    assert.ok(pageHeading, pathname + " is missing an H1");
    assert.match(html, /index,follow/);
    assert.equal(pageCanonical, SITE_URL + pathname, pathname + " has an unexpected canonical");
    assert.equal(countAdSense(html), 1, pathname + " should load AdSense exactly once");
    assert.ok(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length > 600, pathname + " has too little initial HTML content");
    titles.set(pathname, pageTitle);
    descriptions.set(pathname, description);
    canonicals.set(pathname, pageCanonical);

    const tool = TOOL_SEO_CONTENT[pathname];
    const guide = APPROVAL_GUIDES[pathname];
    const processingGuide = pathname === "/browser-vs-local-agent" ? PROCESSING_MODE_GUIDE : null;
    if (tool) {
      assert.match(html, /tool-guide/);
      assert.match(html, /Common mistakes and troubleshooting/);
      assert.match(html, /Export verification checklist/);
      for (const [, answer] of tool.faqs || []) assert.ok(html.includes(answer), pathname + " hides FAQ answer from initial HTML");
    }
    if (guide) {
      assert.match(html, /Written by/);
      for (const [, answer] of guide.faqs || []) assert.ok(html.includes(answer), pathname + " hides FAQ answer from initial HTML");
    }
    if (processingGuide) {
      assert.match(html, /Written by/);
      for (const [, answer] of processingGuide.faqs || []) assert.ok(html.includes(answer), pathname + " hides FAQ answer from initial HTML");
    }
  }

  assert.equal(new Set(titles.values()).size, titles.size, "Indexable routes must have unique titles");
  assert.equal(new Set(descriptions.values()).size, descriptions.size, "Indexable routes must have unique descriptions");
  assert.equal(new Set(canonicals.values()).size, canonicals.size, "Indexable routes must have unique canonicals");

  for (const pathname of DEFERRED_ROUTES) {
    const html = await fetchText(pathname);
    assert.match(html, /noindex,follow/);
    assert.equal(countAdSense(html), 0, pathname + " must not load AdSense");
  }
  for (const pathname of INSTALLER_ROUTES) {
    const response = await fetch(baseUrl + pathname, { redirect: "manual" });
    assert.ok(response.status >= 300 && response.status < 400, pathname + " must remain a redirect and not an indexable installer page");
  }

  const sitemap = await fetchText("/sitemap.xml");
  const sitemapRoutes = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
  assert.deepEqual(sitemapRoutes, PUBLIC_ROUTES.map(({ path }) => path), "Sitemap must exactly match the approval surface");
  for (const { path, lastmod } of PUBLIC_ROUTES) {
    const loc = path === "/" ? SITE_URL + "/" : SITE_URL + path;
    const escapedLoc = loc.replace(/[\^$.*+?()[\]{}|]/g, "\\$&");
    assert.match(sitemap, new RegExp("<loc>" + escapedLoc + "</loc>[\\s\\S]*?<lastmod>" + lastmod + "</lastmod>"));
  }
  assert.deepEqual(Object.fromEntries(PUBLIC_ROUTES.map(({ path, lastmod }) => [path, lastmod])), ROUTE_LAST_MODIFIED, "Sitemap route dates drifted from the policy");

  const robots = await fetchText("/robots.txt");
  assert.match(robots, /User-agent: Mediapartners-Google[\s\S]*Allow: \//);
  assert.match(robots, /User-agent: Google-Display-Ads-Bot[\s\S]*Allow: \//);
  assert.match(robots, /Disallow: \/api\//);

  const adsTxt = await fetchText("/ads.txt");
  assert.match(adsTxt, /^google\.com, pub-8789714270333969, DIRECT, f08c47fec0942fa0$/m);
  console.log("SEO production verification passed for " + APPROVAL_ROUTE_PATHS.length + " indexable and " + DEFERRED_ROUTES.length + " noindex routes.");
}

try {
  await verify();
} finally {
  server?.kill("SIGTERM");
}
