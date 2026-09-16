export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://native-media-agent.vercel.app").replace(/\/+$/, "");
export const PRODUCT_NAME = "NativeMedia Agent";
export const PRODUCT_TAGLINE = "Your browser interface. Your computer does the work.";
export const AUTHOR_NAME = "Aman Gupta";
export const AUTHOR_EMAIL = "a20000.gupta@gmail.com";
export const AUTHOR_ID = `${SITE_URL}#author`;

export const PUBLIC_ROUTES = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/image-converter", changefreq: "monthly", priority: "0.9" },
  { path: "/svg-to-png", changefreq: "monthly", priority: "0.9" },
  { path: "/video-repair", changefreq: "monthly", priority: "0.8" },
  { path: "/local-agent", changefreq: "monthly", priority: "0.8" },
  { path: "/how-to-setup-agent", changefreq: "monthly", priority: "0.8" },
  { path: "/pdf-editor", changefreq: "monthly", priority: "0.8" },
  { path: "/pdf-text-editor", changefreq: "monthly", priority: "0.8" },
  { path: "/pdf-compressor", changefreq: "monthly", priority: "0.8" },
  { path: "/coming-soon", changefreq: "monthly", priority: "0.5" },
  { path: "/privacy", changefreq: "yearly", priority: "0.3" },
  { path: "/terms", changefreq: "yearly", priority: "0.3" },
  { path: "/contact", changefreq: "monthly", priority: "0.4" },
];

const defaultMetadata = {
  title: `Private Desktop PDF & Media Tools | ${PRODUCT_NAME}`,
  description: `Private desktop tools to convert images, repair videos, edit PDFs, and compress documents with the ${PRODUCT_NAME} on macOS, Windows, or Linux.`,
  keywords: "desktop PDF tools, local media tools, NativeMedia Agent, image converter, video repair, PDF editor, private file processing",
  breadcrumbLabel: "Home",
};

export const SEO_BY_ROUTE = {
  "/image-converter": {
    title: `Desktop Image Converter | ${PRODUCT_NAME}`,
    description: `Convert JPG, PNG, HEIC, TIFF, GIF, and BMP images with the ${PRODUCT_NAME} on macOS, Windows, or Linux. Browser mode accepts images up to 5 MB each for quick PNG or JPG conversions, while Local agent supports up to 25 MB per image and the full desktop format workflow.`,
    keywords: "desktop image converter, local JPG converter, PNG converter, HEIC converter, TIFF converter, NativeMedia Agent",
    breadcrumbLabel: "Image converter",
  },
  "/svg-to-png": {
    title: `SVG to PNG Converter | ${PRODUCT_NAME}`,
    description: `Convert SVG files or pasted SVG code to PNG with the ${PRODUCT_NAME} on macOS, Windows, or Linux. Export at 1×, 2×, 3×, 4×, or a custom size with a transparent or color-picked background.`,
    keywords: "SVG to PNG converter, convert SVG to PNG, rasterize SVG, transparent PNG, custom PNG size, NativeMedia Agent",
    breadcrumbLabel: "SVG to PNG converter",
  },
  "/video-repair": {
    title: `Desktop Video Repair Tool | ${PRODUCT_NAME}`,
    description: `Repair damaged MP4, M4V, MOV, 3GP, MKV, WebM, AVI, MPEG, and MPG videos with the ${PRODUCT_NAME} on macOS, Windows, or Linux, using layered recovery and reference support.`,
    keywords: "desktop video repair tool, repair MP4, fix damaged video, recover video, local video repair, NativeMedia Agent",
    breadcrumbLabel: "Video repair",
  },
  "/local-agent": {
    title: `Private Local File Processing | ${PRODUCT_NAME}`,
    description: `Connect the ${PRODUCT_NAME} desktop app on macOS, Windows, or Linux to process supported media files locally, keep source files on your device, and manage results securely.`,
    keywords: "local file processing, private desktop media tools, NativeMedia Agent, offline file processing",
    breadcrumbLabel: "Local agent",
  },
  "/how-to-setup-agent": {
    title: `How to Set Up the Local Agent | ${PRODUCT_NAME}`,
    description: `Follow the ${PRODUCT_NAME} setup guide for macOS, Windows, and Linux to install the desktop Local agent, connect your browser, authorize the app, and process files on your computer.`,
    keywords: "how to set up NativeMedia Agent, local agent installation, macOS media tools, Windows media tools, Linux media tools",
    breadcrumbLabel: "How to set up the agent",
  },
  "/pdf-editor": {
    title: `Desktop PDF Editor | ${PRODUCT_NAME}`,
    description: `Edit PDF documents with the ${PRODUCT_NAME} on macOS, Windows, or Linux by merging files, reordering pages, adding blank pages, supported images, and text boxes without overwriting sources.`,
    keywords: "desktop PDF editor, merge PDF, reorder PDF pages, add text to PDF, local PDF editor, NativeMedia Agent",
    breadcrumbLabel: "PDF editor",
  },
  "/pdf-text-editor": {
    title: `Desktop PDF Text Editor | ${PRODUCT_NAME}`,
    description: `Edit searchable and scanned PDF text with the ${PRODUCT_NAME} on macOS, Windows, or Linux using OCR-assisted selection, formatting controls, and safe export options.`,
    keywords: "desktop PDF text editor, edit PDF text, OCR PDF editor, change text in PDF, NativeMedia Agent",
    breadcrumbLabel: "PDF text editor",
  },
  "/pdf-compressor": {
    title: `Desktop PDF Compressor | ${PRODUCT_NAME}`,
    description: `Compress PDF files with the ${PRODUCT_NAME} on macOS, Windows, or Linux using Local agent quality profiles, or Browser mode for quick PDFs up to 10 MB, without changing the original.`,
    keywords: "desktop PDF compressor, reduce PDF size, compress PDF, shrink PDF, local PDF compressor, NativeMedia Agent",
    breadcrumbLabel: "PDF compressor",
  },
  "/coming-soon": {
    title: `PDF & Media Tools Roadmap | ${PRODUCT_NAME}`,
    description: `Explore the ${PRODUCT_NAME} roadmap for upcoming private utilities that will expand image, video, PDF, and local-agent workflows on supported desktop computers.`,
    keywords: "NativeMedia Agent roadmap, planned media tools",
    breadcrumbLabel: "Roadmap",
  },
  "/privacy": {
    title: `Privacy Policy | ${PRODUCT_NAME}`,
    description: `Read the ${PRODUCT_NAME} Privacy Policy to learn how local-agent processing on macOS, Windows, and Linux, device identifiers, licensing data, audit logs, and retained results are handled.`,
    keywords: "NativeMedia Agent privacy policy, file privacy, local processing",
    breadcrumbLabel: "Privacy policy",
  },
  "/terms": {
    title: `Terms and Conditions | ${PRODUCT_NAME}`,
    description: `Read the ${PRODUCT_NAME} Terms and Conditions covering lawful use, local-agent authorization, licensing, file ownership, processing limitations, availability, and service changes.`,
    keywords: "NativeMedia Agent terms, terms and conditions, local software terms",
    breadcrumbLabel: "Terms",
  },
  "/contact": {
    title: `Contact Us | ${PRODUCT_NAME}`,
    description: `Contact the ${PRODUCT_NAME} operator with questions, suggestions, feedback, or privacy and licensing requests about the desktop local-agent media tools.`,
    keywords: "NativeMedia Agent contact, media tools support, local-agent support, desktop file processing",
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
  return { ...defaultMetadata, ...(SEO_BY_ROUTE[normalizeSitePath(pathname)] || {}) };
}

export function absoluteSiteUrl(pathname = "/") {
  const path = normalizeSitePath(pathname);
  return `${SITE_URL}${path === "/" ? "/" : path}`;
}
