export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://media-toolbox-woad.vercel.app").replace(/\/+$/, "");
export const AUTHOR_NAME = "Aman Gupta";
export const AUTHOR_EMAIL = "a20000.gupta@gmail.com";
export const AUTHOR_ID = `${SITE_URL}#author`;

export const PUBLIC_ROUTES = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
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
  title: "Private Desktop PDF & Media Tools | Media Toolbox",
  description: "Private desktop tools to convert images, repair videos, edit PDFs, and compress documents with the Media Toolbox Local agent on macOS, Windows, or Linux.",
  keywords: "desktop PDF tools, local media tools, image converter, video repair, PDF editor, PDF compressor, private file processing",
  breadcrumbLabel: "Home",
};

export const SEO_BY_ROUTE = {
  "/image-converter": {
    title: "Desktop Image Converter | Media Toolbox",
    description: "Convert JPG, PNG, HEIC, TIFF, GIF, and BMP images with the Media Toolbox Local agent on macOS, Windows, or Linux, using batch settings while preserving pixel dimensions.",
    keywords: "desktop image converter, local JPG converter, PNG converter, HEIC converter, TIFF converter",
    breadcrumbLabel: "Image converter",
  },
  "/video-repair": {
    title: "Desktop Video Repair Tool | Media Toolbox",
    description: "Repair damaged or unreadable MP4, MOV, MKV, and WebM videos with the Media Toolbox Local agent on macOS, Windows, or Linux, using layered recovery and reference support.",
    keywords: "desktop video repair tool, repair MP4, fix damaged video, recover video, local video repair",
    breadcrumbLabel: "Video repair",
  },
  "/local-agent": {
    title: "Private Local File Processing | Media Toolbox",
    description: "Connect the Media Toolbox desktop agent on macOS, Windows, or Linux to process supported media files locally, keep source files on your device, and manage results securely.",
    keywords: "local file processing, private desktop media tools, Media Toolbox agent, offline file processing",
    breadcrumbLabel: "Local agent",
  },
  "/pdf-editor": {
    title: "Desktop PDF Editor | Media Toolbox",
    description: "Edit PDFs with the Media Toolbox Local agent on macOS, Windows, or Linux by merging documents, reordering pages, adding blank pages, images, and text boxes without overwriting sources.",
    keywords: "desktop PDF editor, merge PDF, reorder PDF pages, add text to PDF, local PDF editor",
    breadcrumbLabel: "PDF editor",
  },
  "/pdf-text-editor": {
    title: "Desktop PDF Text Editor | Media Toolbox",
    description: "Edit searchable and scanned PDF text with the Media Toolbox Local agent on macOS, Windows, or Linux using OCR-assisted selection, formatting controls, and safe export options.",
    keywords: "desktop PDF text editor, edit PDF text, OCR PDF editor, change text in PDF",
    breadcrumbLabel: "PDF text editor",
  },
  "/pdf-compressor": {
    title: "Desktop PDF Compressor | Media Toolbox",
    description: "Compress PDF files with the Media Toolbox Local agent on macOS, Windows, or Linux using selectable quality profiles, image optimization, and size controls without changing the original.",
    keywords: "desktop PDF compressor, reduce PDF size, compress PDF, shrink PDF, local PDF compressor",
    breadcrumbLabel: "PDF compressor",
  },
  "/coming-soon": {
    title: "PDF & Media Tools Roadmap | Media Toolbox",
    description: "Explore the Media Toolbox roadmap for upcoming private utilities that will expand image, video, PDF, and Local agent workflows on supported desktop computers.",
    keywords: "Media Toolbox roadmap, planned media tools",
    breadcrumbLabel: "Roadmap",
  },
  "/privacy": {
    title: "Privacy Policy | Media Toolbox",
    description: "Read the Media Toolbox Privacy Policy to learn how Local agent processing on macOS, Windows, and Linux, device identifiers, licensing data, audit logs, and retained results are handled.",
    keywords: "Media Toolbox privacy policy, file privacy, local processing",
    breadcrumbLabel: "Privacy policy",
  },
  "/terms": {
    title: "Terms and Conditions | Media Toolbox",
    description: "Read the Media Toolbox Terms and Conditions covering lawful use, local-agent authorization, licensing, file ownership, processing limitations, availability, and service changes.",
    keywords: "Media Toolbox terms, terms and conditions, local software terms",
    breadcrumbLabel: "Terms",
  },
  "/admin": {
    title: "Admin | Media Toolbox",
    description: "Private Media Toolbox licensing administration.",
    keywords: "Media Toolbox admin",
    noIndex: true,
  },
  "/license-admin": {
    title: "License Administration | Media Toolbox",
    description: "Private Media Toolbox licensing administration.",
    keywords: "Media Toolbox license administration",
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
