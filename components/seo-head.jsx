import Head from "next/head";
import { useRouter } from "next/router";
import { absoluteSiteUrl, metadataForPathname, SITE_URL } from "../lib/site-metadata.js";

export function SeoHead() {
  const { pathname } = useRouter();
  const metadata = metadataForPathname(pathname);
  const canonicalUrl = absoluteSiteUrl(pathname);
  const robots = metadata.noIndex ? "noindex,nofollow" : "index,follow,max-image-preview:large";
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Media Toolbox",
    url: SITE_URL,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Web browser, macOS, Windows, Linux",
    description: metadata.description,
  };

  return <Head>
    <title>{metadata.title}</title>
    <meta name="description" content={metadata.description} />
    <meta name="keywords" content={metadata.keywords} />
    <meta name="author" content="Media Toolbox" />
    <meta name="application-name" content="Media Toolbox" />
    <meta name="robots" content={robots} />
    <meta name="referrer" content="strict-origin-when-cross-origin" />
    <link rel="canonical" href={canonicalUrl} />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Media Toolbox" />
    <meta property="og:url" content={canonicalUrl} />
    <meta property="og:title" content={metadata.title} />
    <meta property="og:description" content={metadata.description} />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content={metadata.title} />
    <meta name="twitter:description" content={metadata.description} />
    {!metadata.noIndex && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />}
  </Head>;
}
