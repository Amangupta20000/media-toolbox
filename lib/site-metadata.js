export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://native-media-agent.vercel.app").replace(/\/+$/, "");
export const PRODUCT_NAME = "NativeMedia Agent";
export const PRODUCT_TAGLINE = "Your browser interface. Your computer does the work.";
export const AUTHOR_NAME = "Aman Gupta";
export const AUTHOR_EMAIL = "a20000.gupta@gmail.com";
export const ADSENSE_CLIENT_ID = "ca-pub-8789714270333969";
export const AUTHOR_ID = `${SITE_URL}#author`;
export const CONTENT_LAST_UPDATED = "2026-10-06";

// Keep the approval surface in one place. Sitemap entries, noindex behavior,
// AdSense loading, and the production SEO checks all derive from this policy.
export const APPROVAL_ROUTE_PATHS = Object.freeze([
  "/",
  "/image-converter",
  "/svg-to-png",
  "/pdf-editor",
  "/pdf-text-editor",
  "/pdf-compressor",
  "/pdf-to-images",
  "/video-repair",
  "/guides",
  "/guides/convert-images-without-uploading",
  "/guides/convert-svg-to-png",
  "/guides/edit-and-merge-pdf",
  "/guides/compress-pdf",
  "/browser-vs-local-agent",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
]);

export const DEFERRED_ROUTES = Object.freeze([
  "/local-agent",
  "/how-to-setup-agent",
  "/video-compressor",
  "/audio-extractor",
  "/mock-api",
  "/offers",
  "/coming-soon",
]);

export const INSTALLER_ROUTES = Object.freeze([
  "/downloads/macos",
  "/downloads/windows",
  "/downloads/linux",
]);

export const ROUTE_LAST_MODIFIED = Object.freeze({
  "/": CONTENT_LAST_UPDATED,
  "/image-converter": CONTENT_LAST_UPDATED,
  "/svg-to-png": CONTENT_LAST_UPDATED,
  "/pdf-editor": CONTENT_LAST_UPDATED,
  "/pdf-text-editor": CONTENT_LAST_UPDATED,
  "/pdf-compressor": CONTENT_LAST_UPDATED,
  "/pdf-to-images": CONTENT_LAST_UPDATED,
  "/video-repair": CONTENT_LAST_UPDATED,
  "/guides": CONTENT_LAST_UPDATED,
  "/guides/convert-images-without-uploading": CONTENT_LAST_UPDATED,
  "/guides/convert-svg-to-png": CONTENT_LAST_UPDATED,
  "/guides/edit-and-merge-pdf": CONTENT_LAST_UPDATED,
  "/guides/compress-pdf": CONTENT_LAST_UPDATED,
  "/browser-vs-local-agent": CONTENT_LAST_UPDATED,
  "/about": CONTENT_LAST_UPDATED,
  "/contact": CONTENT_LAST_UPDATED,
  "/privacy": "2026-09-18",
  "/terms": "2026-09-18",
});

export const PUBLIC_ROUTES = Object.freeze(APPROVAL_ROUTE_PATHS.map((path) => ({
  path,
  lastmod: ROUTE_LAST_MODIFIED[path],
})));

export const ROUTE_POLICY = Object.freeze([
  ...APPROVAL_ROUTE_PATHS.map((path) => ({ path, indexable: true, loadAdsense: true })),
  ...DEFERRED_ROUTES.map((path) => ({ path, indexable: false, loadAdsense: false })),
  ...INSTALLER_ROUTES.map((path) => ({ path, indexable: false, loadAdsense: false, redirect: true })),
]);

const ROUTE_POLICY_BY_PATH = new Map(ROUTE_POLICY.map((policy) => [policy.path, policy]));

const defaultMetadata = {
  title: `Free Private PDF & Media Tools | ${PRODUCT_NAME}`,
  description: `Free private tools to convert images, convert SVG to PNG, repair videos, edit and merge PDFs, and compress documents. Use Browser mode for lightweight work or Local agent for larger files and advanced processing.`,
  keywords: "free private PDF tools, free image converter, SVG to PNG converter, video repair, PDF editor, PDF compressor, local file processing, NativeMedia Agent",
  breadcrumbLabel: "Home",
};

export const SEO_BY_ROUTE = {
  "/image-converter": {
    title: `Free Private Image Converter — No Upload | ${PRODUCT_NAME}`,
    description: `Convert JPG, JPEG, PNG, GIF, and BMP images in your browser without uploading them to a server. Browser mode supports up to 5 MB per image; Local agent handles HEIC, TIFF, and files up to 25 MB.`,
    keywords: "free private image converter, image converter no upload, JPG to PNG converter, PNG to JPG converter, HEIC converter, TIFF converter, NativeMedia Agent",
    breadcrumbLabel: "Image converter",
  },
  "/svg-to-png": {
    title: `Free SVG to PNG Converter | ${PRODUCT_NAME}`,
    description: `Convert SVG files or pasted SVG code to crisp PNG images with transparent, solid, or gradient backgrounds. Browser mode supports 1×–4× without uploading; Local agent also supports custom dimensions up to 8192 × 8192 pixels.`,
    keywords: "free SVG to PNG converter, convert SVG to PNG, rasterize SVG, transparent PNG, gradient PNG background, custom PNG size, Figma SVG export, SVG renderer, NativeMedia Agent",
    breadcrumbLabel: "SVG to PNG converter",
  },
  "/video-repair": {
    title: `Repair Damaged Video Files Locally | ${PRODUCT_NAME}`,
    description: `Repair damaged MP4, MOV, M4V, MKV, WebM, AVI, 3GP, MPEG, and MPG videos on your computer with layered recovery and optional matching-reference support. Browser mode is unavailable; the original video stays untouched.`,
    keywords: "repair damaged MP4, repair corrupted video, fix damaged MOV, video recovery tool, private video repair tool, local video repair, NativeMedia Agent",
    breadcrumbLabel: "Video repair",
  },
  "/video-compressor": {
    title: "Private Video Compressor — Reduce MP4 Size Locally | " + PRODUCT_NAME,
    description: "Compress MP4, MOV, M4V, MKV, WebM, AVI, 3GP, MPEG, and MPG videos on your computer with practical quality presets. The original video stays untouched and files up to 2 GB are supported.",
    keywords: "free video compressor, compress MP4, reduce video file size, private video compression, local video compressor, NativeMedia Agent",
    breadcrumbLabel: "Video compressor",
    noIndex: true,
  },
  "/audio-extractor": {
    title: "Video to Audio Converter | " + PRODUCT_NAME,
    description: "Convert video to audio locally as MP3, WAV, AAC, FLAC, or M4A. Choose a practical output format, keep the original video untouched, and download a new audio file.",
    keywords: "video to audio, video to audio converter, extract audio from video, video to MP3, MP4 to MP3, audio extractor, private audio extraction, local audio extractor, NativeMedia Agent",
    breadcrumbLabel: "Audio extractor",
    noIndex: true,
  },
  "/local-agent": {
    title: `Private Local File Processing | ${PRODUCT_NAME}`,
    description: `Process images, videos, and PDFs privately on your Mac, Windows, or Linux computer with the ${PRODUCT_NAME} desktop app. Your source files stay in the local processing workflow and remain untouched.`,
    keywords: "private local file processing, offline media tools, local PDF tools, private desktop media tools, NativeMedia Agent",
    breadcrumbLabel: "Local agent",
    noIndex: true,
  },
  "/offers": {
    title: `Local Agent Offers and Activation Codes | ${PRODUCT_NAME}`,
    description: `Find current ${PRODUCT_NAME} Local agent offers, launch codes, and promotional access. Each offer explains its access duration and whether redemption is unlimited until expiry or limited to one use per person.`,
    keywords: "NativeMedia Agent offers, Local agent activation code, desktop app promotion, FreeForAll code, local file processing offer",
    breadcrumbLabel: "Offers",
    noIndex: true,
  },
  "/how-to-setup-agent": {
    title: `How to Install NativeMedia Agent | ${PRODUCT_NAME}`,
    description: `Follow this NativeMedia Agent setup guide for macOS, Windows, and Linux to download the desktop app, connect it to your browser, authorize it, and process files on your computer.`,
    keywords: "how to install NativeMedia Agent, local agent setup, local agent installation, macOS media tools, Windows media tools, Linux media tools",
    breadcrumbLabel: "How to set up the agent",
    noIndex: true,
  },
  "/browser-vs-local-agent": {
    title: `Browser Mode vs Local Agent | ${PRODUCT_NAME}`,
    description: `Compare Browser mode and Local agent for private file processing. See upload behavior, limits, PDF and media features, installation needs, and which option fits your task.`,
    keywords: "Browser mode vs Local agent, browser file processing, private local file processing, online vs desktop PDF tools, NativeMedia Agent",
    breadcrumbLabel: "Browser vs Local agent",
  },
  "/mock-api": {
    title: `Free Mock API Generator for Frontend Testing | ${PRODUCT_NAME}`,
    description: `Create mock REST APIs with JSON responses for frontend development, demos, and API testing. Run callable endpoints on the website Server or through a private Local agent on your computer.`,
    keywords: "mock API generator, mock REST API, JSON mock server, API mocking for frontend testing, fake API for development, localhost API, private mock API, NativeMedia Agent",
    breadcrumbLabel: "Mock API",
    noIndex: true,
  },
  "/pdf-editor": {
    title: `Free PDF Editor — Merge & Organize Pages | ${PRODUCT_NAME}`,
    description: `Merge PDFs, reorder pages, add blank pages and images, and export a new document without overwriting your originals. Browser mode supports lightweight editing; Local agent adds advanced text boxes and duplicate pages.`,
    keywords: "free PDF editor, merge PDF, organize PDF pages, reorder PDF pages, add text to PDF, local PDF editor, NativeMedia Agent",
    breadcrumbLabel: "PDF editor",
  },
  "/pdf-text-editor": {
    title: `Free PDF Text Editor — Edit Searchable PDFs | ${PRODUCT_NAME}`,
    description: `Replace searchable PDF text while preserving page layout. Browser mode edits selectable text in one PDF; Local agent adds OCR for scans, formatting, and text placement tools.`,
    keywords: "free PDF text editor, edit searchable PDF, change text in PDF, OCR PDF editor, replace PDF text, NativeMedia Agent",
    breadcrumbLabel: "PDF text editor",
  },
  "/pdf-compressor": {
    title: `Free PDF Compressor — Reduce PDF Size | ${PRODUCT_NAME}`,
    description: `Reduce PDF file size with balanced, smaller-file, high-quality, and custom compression profiles. Browser mode handles PDFs up to 10 MB; Local agent supports larger files and more controls.`,
    keywords: "free PDF compressor, reduce PDF size, compress PDF, shrink PDF, PDF optimizer, local PDF compressor, NativeMedia Agent",
    breadcrumbLabel: "PDF compressor",
  },
  "/pdf-to-images": {
    title: "Convert PDF to JPG or PNG Images | " + PRODUCT_NAME,
    description: "Convert PDF pages to high-quality JPG or PNG images in one ZIP archive. Choose output scale and JPG quality, process the PDF with the Local agent, and keep the original document untouched.",
    keywords: "PDF to images, PDF to JPG, PDF to PNG, convert PDF pages to images, private PDF converter, local PDF tools, NativeMedia Agent",
    breadcrumbLabel: "PDF to images",
  },
  "/coming-soon": {
    title: `PDF & Media Tools Roadmap | ${PRODUCT_NAME}`,
    description: `Explore the ${PRODUCT_NAME} roadmap for upcoming private utilities that will expand image, video, PDF, and local-agent workflows on supported desktop computers.`,
    keywords: "NativeMedia Agent roadmap, planned media tools",
    breadcrumbLabel: "Roadmap",
    noIndex: true,
  },
  "/guides": {
    title: `Practical PDF, Image, and Privacy Guides | ${PRODUCT_NAME}`,
    description: `Read practical guides for private image conversion, SVG export, PDF editing, PDF compression, and choosing between Browser mode and Local agent in ${PRODUCT_NAME}.`,
    keywords: "image conversion guide, SVG to PNG guide, PDF editing guide, PDF compression guide, private file processing guide",
    breadcrumbLabel: "Guides",
  },
  "/guides/convert-images-without-uploading": {
    title: `How to Convert Images Without Uploading Them | ${PRODUCT_NAME}`,
    description: `Learn how to convert JPG, PNG, GIF, BMP, HEIC, and TIFF images while choosing the right Browser mode or Local agent workflow for file size, format support, and privacy.`,
    keywords: "convert images without uploading, private image conversion guide, JPG PNG conversion guide, HEIC conversion guide",
    breadcrumbLabel: "Convert images without uploading",
  },
  "/guides/convert-svg-to-png": {
    title: `How to Export SVG as PNG With the Right Size | ${PRODUCT_NAME}`,
    description: `Learn how SVG dimensions, export scale, transparency, solid backgrounds, gradients, and blocked external resources affect SVG-to-PNG output.`,
    keywords: "SVG to PNG guide, export SVG as PNG, transparent PNG from SVG, Figma SVG export guide",
    breadcrumbLabel: "Convert SVG to PNG",
  },
  "/guides/edit-and-merge-pdf": {
    title: `How to Edit and Merge PDF Pages | ${PRODUCT_NAME}`,
    description: `Learn how to merge PDFs, reorder pages, add pages, place images, and make safe PDF edits while keeping the original documents untouched.`,
    keywords: "how to merge PDF pages, PDF editing guide, reorder PDF pages, private PDF editor guide",
    breadcrumbLabel: "Edit and merge PDFs",
  },
  "/guides/compress-pdf": {
    title: `How to Compress a PDF Without Losing More Quality Than Needed | ${PRODUCT_NAME}`,
    description: `Learn how to choose PDF compression settings, understand image-heavy documents, preserve searchable text where possible, and check the exported file.`,
    keywords: "how to compress PDF, reduce PDF size guide, PDF quality guide, private PDF compression",
    breadcrumbLabel: "Compress a PDF",
  },
  "/about": {
    title: `About ${PRODUCT_NAME}`,
    description: `Learn who maintains ${PRODUCT_NAME}, why the private file tools were built, how Browser mode and Local agent processing work, and how to contact the owner.`,
    keywords: "about NativeMedia Agent, private file tools, local media processing, Aman Gupta",
    breadcrumbLabel: "About",
  },
  "/privacy": {
    title: `Privacy Policy | ${PRODUCT_NAME}`,
    description: `Read the ${PRODUCT_NAME} Privacy Policy for Browser mode, Local agent and server processing, analytics consent, AdSense disclosures, cookies, licensing data, and retained results.`,
    keywords: "NativeMedia Agent privacy policy, browser file privacy, local processing, AdSense cookies",
    breadcrumbLabel: "Privacy policy",
  },
  "/terms": {
    title: `Terms and Conditions | ${PRODUCT_NAME}`,
    description: `Read the ${PRODUCT_NAME} Terms and Conditions covering Browser mode, Local agent and server processing, lawful use, file ownership, limitations, availability, and service changes.`,
    keywords: "NativeMedia Agent terms, terms and conditions, browser processing terms, local software terms",
    breadcrumbLabel: "Terms",
  },
  "/contact": {
    title: `Contact Us | ${PRODUCT_NAME}`,
    description: `Contact the ${PRODUCT_NAME} operator with questions, bug reports, suggestions, feedback, or privacy and licensing requests about the Browser and Local-agent media tools.`,
    keywords: "NativeMedia Agent contact, media tools support, browser support, local-agent support, privacy requests",
    breadcrumbLabel: "Contact us",
  },
  "/admin": {
    title: `Admin | ${PRODUCT_NAME}`,
    description: `Private ${PRODUCT_NAME} licensing administration.`,
    keywords: "NativeMedia Agent admin",
    noIndex: true,
  },
  "/license-admin": {
    title: `License Administration | ${PRODUCT_NAME}`,
    description: `Private ${PRODUCT_NAME} licensing administration.`,
    keywords: "NativeMedia Agent license administration",
    noIndex: true,
  },
};

export function normalizeSitePath(pathname = "/") {
  const path = String(pathname).split(/[?#]/, 1)[0].replace(/\/+$/, "");
  return path || "/";
}

export function metadataForPathname(pathname = "/") {
  const normalizedPath = normalizeSitePath(pathname);
  const policy = ROUTE_POLICY_BY_PATH.get(normalizedPath);
  return {
    ...defaultMetadata,
    ...(SEO_BY_ROUTE[normalizedPath] || {}),
    ...(policy && !policy.indexable ? { noIndex: true } : {}),
  };
}

export function routePolicyForPathname(pathname = "/") {
  return ROUTE_POLICY_BY_PATH.get(normalizeSitePath(pathname)) || null;
}

export function lastModifiedForPathname(pathname = "/") {
  return ROUTE_LAST_MODIFIED[normalizeSitePath(pathname)] || CONTENT_LAST_UPDATED;
}

export function absoluteSiteUrl(pathname = "/") {
  const path = normalizeSitePath(pathname);
  return `${SITE_URL}${path === "/" ? "/" : path}`;
}
