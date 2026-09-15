import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AUTHOR_EMAIL, AUTHOR_ID, AUTHOR_NAME, metadataForPathname, PUBLIC_ROUTES, SITE_URL } from "../lib/site-metadata.js";

const projectDirectory = path.resolve(new URL("..", import.meta.url).pathname);

async function read(relativePath) {
  return fs.readFile(path.join(projectDirectory, relativePath), "utf8");
}

test("public site surfaces have legal links and SEO metadata", async () => {
  const app = await read("pages/_app.jsx");
  const document = await read("pages/_document.jsx");
  const shell = await read("components/app-shell.jsx");
  const toolSeo = await read("components/tool-seo-content.jsx");
  const toolSeoData = await read("lib/tool-seo-content.js");
  const footer = await read("components/app-footer.jsx");
  const seo = await read("components/seo-head.jsx");
  const processingMode = await read("components/processing-mode.jsx");
  const history = await read("components/tool-history.jsx");
  const privacy = await read("pages/privacy.jsx");
  const terms = await read("pages/terms.jsx");
  const home = await read("pages/index.jsx");
  const styles = await read("styles/globals.css");

  assert.match(app, /SeoHead/);
  assert.match(document, /<Html lang="en">/);
  assert.match(document, /name="theme-color"/);
  assert.match(shell, /AppFooter/);
  assert.match(shell, /<Link href="\/" title="Home">Home<\/Link>/);
  assert.match(shell, /<img className="brand-logo" src="\/media-toolbox-logo\.png" alt="Media Toolbox logo" title="Media Toolbox" \/>/);
  assert.match(footer, /href="\/privacy" title="Privacy Policy"/);
  assert.match(footer, /href="\/terms" title="Terms and Conditions"/);
  assert.match(footer, /href="\/sitemap\.xml" title="Sitemap"/);
  assert.match(footer, /href="\/privacy"/);
  assert.match(footer, /href="\/terms"/);
  assert.match(footer, /href="\/sitemap\.xml"/);
  assert.match(seo, /meta name="description"/);
  assert.match(seo, /meta name="author" content=\{AUTHOR_NAME\}/);
  assert.match(seo, /meta name="publisher" content="Media Toolbox"/);
  assert.match(seo, /meta name="googlebot"/);
  assert.match(seo, /link rel="canonical"/);
  assert.match(seo, /link rel="icon" type="image\/png" href="\/media-toolbox-logo\.png"/);
  assert.match(seo, /link rel="apple-touch-icon" href="\/media-toolbox-logo\.png"/);
  assert.match(seo, /property="og:title"/);
  assert.match(seo, /property="og:image"/);
  assert.match(seo, /name="twitter:card"/);
  assert.match(seo, /application\/ld\+json/);
  assert.match(seo, /"@graph"/);
  assert.match(seo, /"@type": "Person"/);
  assert.match(seo, /"@id": AUTHOR_ID/);
  assert.match(seo, /founder: \{ "@id": AUTHOR_ID \}/);
  assert.match(seo, /contactPoint:/);
  assert.match(seo, /author: \{ "@id": AUTHOR_ID \}/);
  assert.match(seo, /publisher: \{ "@id": `\$\{SITE_URL\}#organization` \}/);
  assert.match(seo, /email: AUTHOR_EMAIL/);
  assert.match(seo, /"@type": "WebSite"/);
  assert.match(seo, /"@type": \["WebApplication", "SoftwareApplication"\]/);
  assert.match(seo, /"@type": "BreadcrumbList"/);
  assert.match(seo, /"@type": "FAQPage"/);
  assert.match(seo, /price: "0"/);
  assert.match(shell, /ToolSeoContent pathname=\{pathname\}/);
  assert.match(shell, /Breadcrumbs pathname=\{pathname\}/);
  assert.match(shell, /Temporary data follows cleanup rules; local results are kept only when you choose\./);
  assert.doesNotMatch(shell, /Files are temporary and auto-cleaned\./);
  assert.match(processingMode, /const modes = \["local"\];/);
  assert.doesNotMatch(processingMode, /Server/);
  assert.doesNotMatch(history, /server/i);
  assert.match(toolSeo, /Frequently asked questions/);
  assert.match(toolSeo, /Privacy and file safety/);
  assert.match(toolSeoData, /"Which image formats are supported\?"/);
  assert.match(toolSeoData, /"Can every damaged video be repaired\?"/);
  assert.match(toolSeoData, /Image processing currently runs through the Local agent/);
  assert.doesNotMatch(toolSeoData, /Server mode|server worker|Server uploads/);
  assert.match(toolSeoData, /the licensing service does not receive media files/);
  assert.doesNotMatch(toolSeoData, /The editor supports up to five PDFs with a combined 200 MB limit/);
  assert.match(home, /Understand retention/);
  assert.match(home, /Private PDF and media tools for your desktop/);
  assert.match(home, /href="\/pdf-editor"/);
  assert.match(home, /href="\/image-converter"/);
  assert.match(home, /Choose the tool for your file/);
  assert.match(privacy, /Privacy Policy/);
  assert.match(privacy, /Media Toolbox is operated by Aman Gupta/);
  assert.match(privacy, /mailto:a20000\.gupta@gmail\.com/);
  assert.doesNotMatch(privacy, /server jobs|server mode|configured server/i);
  assert.match(privacy, /Files and results/);
  assert.match(terms, /Terms and Conditions/);
  assert.match(terms, /Media Toolbox is operated by Aman Gupta/);
  assert.match(terms, /mailto:a20000\.gupta@gmail\.com/);
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
  assert.ok(PUBLIC_ROUTES.some(({ path: route }) => route === "/"));
  assert.ok(PUBLIC_ROUTES.some(({ path: route }) => route === "/privacy"));
  assert.ok(PUBLIC_ROUTES.some(({ path: route }) => route === "/terms"));
  assert.equal(SITE_URL, "https://media-toolbox-woad.vercel.app");
});

test("SEO metadata is route-specific and normalizes query strings", () => {
  assert.equal(AUTHOR_NAME, "Aman Gupta");
  assert.equal(AUTHOR_EMAIL, "a20000.gupta@gmail.com");
  assert.equal(AUTHOR_ID, `${SITE_URL}#author`);
  assert.equal(metadataForPathname("/pdf-editor?tab=history").title, "Desktop PDF Editor | Media Toolbox");
  assert.equal(metadataForPathname("/privacy/").title, "Privacy Policy | Media Toolbox");
  assert.equal(metadataForPathname("/").title, "Private Desktop PDF & Media Tools | Media Toolbox");
  assert.equal(metadataForPathname("/unknown").title, "Private Desktop PDF & Media Tools | Media Toolbox");
  assert.equal(metadataForPathname("/admin").noIndex, true);
  assert.equal(metadataForPathname("/license-admin").noIndex, true);
});

test("indexable page descriptions are useful and within the recommended range", () => {
  const indexableRoutes = ["/", ...PUBLIC_ROUTES.filter(({ path: route }) => route !== "/" && !metadataForPathname(route).noIndex).map(({ path: route }) => route)];
  for (const route of indexableRoutes) {
    const description = metadataForPathname(route).description;
    assert.ok(description.length >= 120 && description.length <= 320, `${route} description length was ${description.length}`);
  }
});
