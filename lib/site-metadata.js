export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://media-toolbox-woad.vercel.app").replace(/\/+$/, "");

export const PUBLIC_ROUTES = [
  { path: "/image-converter", changefreq: "monthly", priority: "0.9" },
  { path: "/video-repair", changefreq: "monthly", priority: "0.8" },
  { path: "/local-agent", changefreq: "monthly", priority: "0.8" },
  { path: "/pdf-editor", changefreq: "monthly", priority: "0.8" },
  { path: "/pdf-text-editor", changefreq: "monthly", priority: "0.8" },
  { path: "/pdf-compressor", changefreq: "monthly", priority: "0.8" },
  { path: "/coming-soon", changefreq: "monthly", priority: "0.5" },
  { path: "/privacy", changefreq: "yearly", priority: "0.3" },
  { path: "/terms", changefreq: "yearly", priority: "0.3" },
];

const defaultMetadata = {
  title: "Media Toolbox | Private media tools",
  description: "Private image, video, and PDF utilities for practical file work on the web and your device.",
  keywords: "media tools, image converter, video repair, PDF editor, PDF compressor, local file processing",
};

export const SEO_BY_ROUTE = {
  "/image-converter": {
    title: "Image Converter | Media Toolbox",
    description: "Convert images between popular formats with a private, practical Media Toolbox workflow.",
    keywords: "image converter, JPG converter, PNG converter, HEIC converter, image tools",
  },
  "/video-repair": {
    title: "Video Repair | Media Toolbox",
    description: "Recover readable video files with a layered repair workflow designed for local processing.",
    keywords: "video repair, recover video, fix MP4, local video repair",
  },
  "/local-agent": {
    title: "Local Agent | Media Toolbox",
    description: "Connect the Media Toolbox local agent to process files on your own computer.",
    keywords: "local file processing, desktop media tools, Media Toolbox agent",
  },
  "/pdf-editor": {
    title: "PDF Editor | Media Toolbox",
    description: "Merge, reorder, add, and save PDF pages with a private document editing workflow.",
    keywords: "PDF editor, merge PDF, reorder PDF pages, local PDF editor",
  },
  "/pdf-text-editor": {
    title: "PDF Text Editor | Media Toolbox",
    description: "Edit searchable PDF text while preserving document structure and formatting where possible.",
    keywords: "PDF text editor, edit PDF text, OCR PDF editor, local PDF editing",
  },
  "/pdf-compressor": {
    title: "PDF Compressor | Media Toolbox",
    description: "Reduce PDF file size with selectable quality and image optimization settings.",
    keywords: "PDF compressor, reduce PDF size, compress PDF, local PDF compressor",
  },
  "/coming-soon": {
    title: "Coming Soon | Media Toolbox",
    description: "Explore the next private media utilities planned for Media Toolbox.",
    keywords: "Media Toolbox roadmap, planned media tools",
  },
  "/privacy": {
    title: "Privacy Policy | Media Toolbox",
    description: "Learn how Media Toolbox handles files, device information, licensing, and website requests.",
    keywords: "Media Toolbox privacy policy, file privacy, local processing",
  },
  "/terms": {
    title: "Terms and Conditions | Media Toolbox",
    description: "Read the terms that apply when using Media Toolbox and its local processing agent.",
    keywords: "Media Toolbox terms, terms and conditions, local software terms",
  },
  "/admin": {
    title: "Admin | Media Toolbox",
    description: "Private Media Toolbox licensing administration.",
    keywords: "Media Toolbox admin",
    noIndex: true,
  },
};

export function normalizeSitePath(pathname = "/") {
  const path = String(pathname).split(/[?#]/, 1)[0].replace(/\/+$/, "");
  return path || "/";
}

export function metadataForPathname(pathname = "/") {
  return { ...defaultMetadata, ...(SEO_BY_ROUTE[normalizeSitePath(pathname)] || {}) };
}

export function absoluteSiteUrl(pathname = "/") {
  const path = normalizeSitePath(pathname);
  return `${SITE_URL}${path === "/" ? "/" : path}`;
}
