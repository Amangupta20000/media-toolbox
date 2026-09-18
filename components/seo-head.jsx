import Head from "next/head";
import { useRouter } from "next/router";
import { absoluteSiteUrl, ADSENSE_CLIENT_ID, AUTHOR_EMAIL, AUTHOR_ID, AUTHOR_NAME, metadataForPathname, normalizeSitePath, PRODUCT_NAME, PRODUCT_TAGLINE, SITE_URL } from "../lib/site-metadata.js";
import { PROCESSING_MODE_GUIDE } from "../lib/processing-mode-guide.js";
import { TOOL_SEO_CONTENT } from "../lib/tool-seo-content.js";

export function SeoHead() {
  const { pathname } = useRouter();
  const metadata = metadataForPathname(pathname);
  const normalizedPath = normalizeSitePath(pathname);
  const canonicalUrl = absoluteSiteUrl(normalizedPath);
  const socialImageUrl = absoluteSiteUrl("/media-toolbox-logo.png");
  const robots = metadata.noIndex ? "noindex,nofollow" : "index,follow,max-image-preview:large";
  const pageLabel = metadata.breadcrumbLabel || metadata.title.replace(/\s*\|\s*NativeMedia Agent$/, "");
  const toolContent = TOOL_SEO_CONTENT[normalizedPath];
  const guideContent = normalizedPath === "/browser-vs-local-agent" ? PROCESSING_MODE_GUIDE : null;
  const organization = {
    "@type": "Organization",
    "@id": `${SITE_URL}#organization`,
    name: PRODUCT_NAME,
    slogan: PRODUCT_TAGLINE,
    url: SITE_URL,
    founder: { "@id": AUTHOR_ID },
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: AUTHOR_EMAIL,
    },
    logo: {
      "@type": "ImageObject",
      url: socialImageUrl,
      width: 256,
      height: 256,
    },
  };
  const author = {
    "@type": "Person",
    "@id": AUTHOR_ID,
    name: AUTHOR_NAME,
    email: AUTHOR_EMAIL,
    worksFor: { "@id": `${SITE_URL}#organization` },
  };
  const website = {
    "@type": "WebSite",
    "@id": `${SITE_URL}#website`,
    url: SITE_URL,
    name: PRODUCT_NAME,
    description: `Native-agent powered media and PDF tools. ${PRODUCT_TAGLINE}`,
    slogan: PRODUCT_TAGLINE,
    publisher: { "@id": `${SITE_URL}#organization` },
  };
  const application = {
    "@type": ["WebApplication", "SoftwareApplication"],
    "@id": `${SITE_URL}#application`,
    name: PRODUCT_NAME,
    slogan: PRODUCT_TAGLINE,
    url: SITE_URL,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "macOS, Windows, Linux",
    browserRequirements: "Requires a modern web browser to connect to the desktop Local agent",
    description: `Private desktop tools for converting images, repairing videos, editing PDFs, and compressing documents through the ${PRODUCT_NAME}.`,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    provider: { "@id": `${SITE_URL}#organization` },
    publisher: { "@id": `${SITE_URL}#organization` },
  };
  const webPage = {
    "@type": "WebPage",
    "@id": `${canonicalUrl}#webpage`,
    url: canonicalUrl,
    name: metadata.title,
    description: metadata.description,
    isPartOf: { "@id": `${SITE_URL}#website` },
    about: { "@id": `${SITE_URL}#application` },
    author: { "@id": AUTHOR_ID },
    publisher: { "@id": `${SITE_URL}#organization` },
  };
  const breadcrumb = normalizedPath === "/" ? null : {
    "@type": "BreadcrumbList",
    "@id": `${canonicalUrl}#breadcrumb`,
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: absoluteSiteUrl("/") },
      { "@type": "ListItem", position: 2, name: pageLabel, item: canonicalUrl },
    ],
  };
  const faqItems = toolContent?.faqs?.length ? toolContent.faqs : guideContent?.faqs;
  const faqPage = faqItems?.length ? {
    "@type": "FAQPage",
    "@id": `${canonicalUrl}#faq`,
    mainEntity: faqItems.map(([question, answer]) => ({
      "@type": "Question",
      name: question,
      acceptedAnswer: { "@type": "Answer", text: answer },
    })),
  } : null;
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [organization, author, website, application, webPage, ...(breadcrumb ? [breadcrumb] : []), ...(faqPage ? [faqPage] : [])],
  };

  return <>
    <Head>
      <title>{metadata.title}</title>
      <meta name="description" content={metadata.description} />
      <meta name="keywords" content={metadata.keywords} />
      <meta name="author" content={AUTHOR_NAME} />
      <meta name="publisher" content={PRODUCT_NAME} />
      <meta name="application-name" content={PRODUCT_NAME} />
      <meta name="robots" content={robots} />
      <meta name="googlebot" content={robots} />
      <meta name="referrer" content="strict-origin-when-cross-origin" />
      <link rel="icon" type="image/png" href="/media-toolbox-logo.png" />
      <link rel="apple-touch-icon" href="/media-toolbox-logo.png" />
      <link rel="canonical" href={canonicalUrl} />
      <meta property="og:type" content="website" />
      <meta property="og:locale" content="en_US" />
      <meta property="og:site_name" content={PRODUCT_NAME} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:title" content={metadata.title} />
      <meta property="og:description" content={metadata.description} />
      <meta property="og:image" content={socialImageUrl} />
      <meta property="og:image:alt" content="NativeMedia Agent app logo" />
      <meta property="og:image:type" content="image/png" />
      <meta property="og:image:width" content="256" />
      <meta property="og:image:height" content="256" />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content={metadata.title} />
      <meta name="twitter:description" content={metadata.description} />
      <meta name="twitter:image" content={socialImageUrl} />
      <meta name="twitter:image:alt" content="NativeMedia Agent app logo" />
      {!metadata.noIndex && <script async src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT_ID}`} crossOrigin="anonymous" />}
      {!metadata.noIndex && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />}
    </Head>
  </>;
}
