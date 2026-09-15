import { absoluteSiteUrl } from "../lib/site-metadata.js";

export default function Robots() {
  return null;
}

export function getServerSideProps({ res }) {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /license-admin",
    "Disallow: /api/",
    `Sitemap: ${absoluteSiteUrl("/sitemap.xml")}`,
    "",
  ].join("\n");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  res.write(body);
  res.end();
  return { props: {} };
}
