import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { metadataForPathname, PUBLIC_ROUTES, SITE_URL } from "../lib/site-metadata.js";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("public site surfaces have legal links and SEO metadata", async () => {
  const app = await read("pages/_app.jsx");
  const document = await read("pages/_document.jsx");
  const shell = await read("components/app-shell.jsx");
  const footer = await read("components/app-footer.jsx");
  const seo = await read("components/seo-head.jsx");
  const privacy = await read("pages/privacy.jsx");
  const terms = await read("pages/terms.jsx");
  const styles = await read("styles/globals.css");

  assert.match(app, /SeoHead/);
  assert.match(document, /<Html lang="en">/);
  assert.match(document, /name="theme-color"/);
  assert.match(shell, /AppFooter/);
  assert.match(footer, /href="\/privacy"/);
  assert.match(footer, /href="\/terms"/);
  assert.match(footer, /href="\/sitemap\.xml"/);
  assert.match(seo, /meta name="description"/);
  assert.match(seo, /link rel="canonical"/);
  assert.match(seo, /link rel="icon" type="image\/png" href="\/media-toolbox-logo\.png"/);
  assert.match(seo, /link rel="apple-touch-icon" href="\/media-toolbox-logo\.png"/);
  assert.match(seo, /property="og:title"/);
  assert.match(seo, /name="twitter:card"/);
  assert.match(seo, /application\/ld\+json/);
  assert.match(privacy, /Privacy Policy/);
  assert.match(privacy, /Files and results/);
  assert.match(terms, /Terms and Conditions/);
  assert.match(terms, /Local agent and licensing/);
  assert.match(styles, /\.app-footer \{/);
  assert.match(styles, /\.legal-document \{/);
});

test("sitemap and robots routes expose only public pages", async () => {
  const sitemap = await read("pages/sitemap.xml.js");
  const robots = await read("pages/robots.txt.js");

  assert.match(sitemap, /Content-Type.*application\/xml/);
  assert.match(sitemap, /PUBLIC_ROUTES/);
  assert.match(sitemap, /getServerSideProps/);
  assert.match(robots, /Disallow: \/admin/);
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /sitemap\.xml/);
  assert.ok(!PUBLIC_ROUTES.some(({ path: route }) => route.startsWith("/admin") || route.startsWith("/api")));
  assert.ok(PUBLIC_ROUTES.some(({ path: route }) => route === "/privacy"));
  assert.ok(PUBLIC_ROUTES.some(({ path: route }) => route === "/terms"));
  assert.equal(SITE_URL, "https://media-toolbox-woad.vercel.app");
});

test("SEO metadata is route-specific and normalizes query strings", () => {
  assert.equal(metadataForPathname("/pdf-editor?tab=history").title, "PDF Editor | Media Toolbox");
  assert.equal(metadataForPathname("/privacy/").title, "Privacy Policy | Media Toolbox");
  assert.equal(metadataForPathname("/unknown").title, "Media Toolbox | Private media tools");
  assert.equal(metadataForPathname("/admin").noIndex, true);
});
