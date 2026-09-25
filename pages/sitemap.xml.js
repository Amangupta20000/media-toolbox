import { absoluteSiteUrl, PUBLIC_ROUTES } from "../lib/site-metadata.js";

function escapeXml(value) {
  return String(value).replace(/[<>&'\"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" }[character]));
}

export default function Sitemap() {
  return null;
}

export function getServerSideProps({ res }) {
  const urls = PUBLIC_ROUTES.map(({ path, lastmod }) => `\n    <url>\n      <loc>${escapeXml(absoluteSiteUrl(path))}</loc>${lastmod ? `\n      <lastmod>${escapeXml(lastmod)}</lastmod>` : ""}\n    </url>`).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}\n</urlset>`;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.write(xml);
  res.end();
  return { props: {} };
}
