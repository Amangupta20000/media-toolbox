import Link from "next/link";
import { Archive, ArrowRight, Check, Code2, FileImage, FileMusic, FileText, FileVideo, Film, Image as ImageIcon, ShieldCheck } from "lucide-react";
import { AppShell } from "../components/app-shell.jsx";
import { PRODUCT_NAME, PRODUCT_TAGLINE } from "../lib/site-metadata.js";

const toolDirectory = [
  { href: "/pdf-editor", label: "Free PDF editor", description: "Merge PDFs, organize pages, add blank pages, and export a new document.", icon: FileText, category: "PDF tools" },
  { href: "/pdf-text-editor", label: "Free PDF text editor", description: "Replace searchable PDF text while preserving its original layout.", icon: FileText, category: "PDF tools" },
  { href: "/pdf-compressor", label: "Free PDF compressor", description: "Reduce PDF file size with balanced and advanced compression profiles.", icon: Archive, category: "PDF tools" },
  { href: "/image-converter", label: "Free private image converter", description: "Convert JPG, JPEG, PNG, GIF, and BMP images without uploading them.", icon: ImageIcon, category: "Media tools" },
  { href: "/svg-to-png", label: "Free SVG to PNG converter", description: "Rasterize SVG artwork with transparent, solid, or gradient backgrounds.", icon: ImageIcon, category: "Media tools" },
  { href: "/video-repair", label: "Private video repair tool", description: "Repair damaged video files with layered local recovery methods.", icon: Film, category: "Media tools" },
  { href: "/video-compressor", label: "Private video compressor", description: "Create a smaller MP4 copy with practical quality presets.", icon: FileVideo, category: "Media tools" },
  { href: "/audio-extractor", label: "Audio extractor", description: "Extract MP3, WAV, AAC, FLAC, or M4A audio from video.", icon: FileMusic, category: "Media tools" },
  { href: "/pdf-to-images", label: "PDF to images", description: "Render PDF pages as PNG or JPG files in one ZIP archive.", icon: FileImage, category: "PDF tools" },
  { href: "/mock-api", label: "Beta mock API", description: "Create JSON REST mocks for frontend development in Browser mode or on localhost.", icon: Code2, category: "Developer tools" },
];

const principles = [
  ["Process files on your computer", "The connected NativeMedia Agent desktop app processes files locally on your Mac, Windows, or Linux computer."],
  ["Keep originals untouched", "Every conversion, repair, or PDF edit creates a new result instead of overwriting your source."],
  ["Understand retention", "Temporary Local agent data follows the agent cleanup rules, and local results are retained only when you choose."],
];

export default function HomePage() {
  return <AppShell>
    <section className="home-hero" aria-labelledby="home-title">
      <div className="section-kicker"><span className="kicker-line" /> Private file tools</div>
      <h1 id="home-title">Free private PDF and media tools</h1>
      <p>Convert images, repair videos, edit PDFs, and reduce document size with {PRODUCT_NAME}. {PRODUCT_TAGLINE} Connect the agent on macOS, Windows, or Linux to keep processing on your computer and your original files untouched.</p>
      <div className="home-actions">
        <Link className="primary-button" href="/pdf-editor" prefetch={false} data-analytics-cta="open_pdf_editor" data-analytics-surface="home">Open PDF editor <ArrowRight size={17} /></Link>
        <Link className="secondary-button" href="/image-converter" prefetch={false} data-analytics-cta="convert_image" data-analytics-surface="home">Try the private image converter</Link>
      </div>
      <div className="home-trust-line"><ShieldCheck size={17} /><span>Processing location shown · source files are not overwritten</span></div>
    </section>

    <section className="home-section" aria-labelledby="home-tools-title">
      <div className="home-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Tool directory</div><h2 id="home-tools-title">Choose the tool for your file</h2></div><div className="home-section-heading-links"><Link className="text-link" href="/browser-vs-local-agent">Compare processing modes <ArrowRight size={15} /></Link><Link className="text-link" href="/coming-soon">See the roadmap <ArrowRight size={15} /></Link></div></div>
      <div className="home-tool-grid">
        {toolDirectory.map(({ href, label, description, icon: Icon, category }) => <Link className="home-tool-card" href={href} prefetch={false} key={href}>
          <span className="home-tool-icon"><Icon size={22} /></span>
          <span className="home-tool-copy"><small>{category}</small><strong>{label}</strong><span>{description}</span></span>
          <ArrowRight className="home-tool-arrow" size={17} aria-hidden="true" />
        </Link>)}
      </div>
    </section>

    <section className="home-section home-principles" aria-labelledby="home-principles-title">
      <div className="home-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> How it works</div><h2 id="home-principles-title">Practical tools with privacy in the workflow</h2></div></div>
      <div className="home-principle-grid">
        {principles.map(([title, description]) => <article className="home-principle-card" key={title}><span className="home-principle-check"><Check size={16} /></span><div><h3>{title}</h3><p>{description}</p></div></article>)}
      </div>
    </section>

    <section className="home-cta" aria-labelledby="home-cta-title">
      <div><div className="section-kicker"><span className="kicker-line" /> Start with a file</div><h2 id="home-cta-title">Need to fix, edit, or convert something?</h2><p>Open a dedicated tool and see its supported formats, limits, and processing options before you submit.</p></div>
      <Link className="primary-button" href="/pdf-compressor" prefetch={false} data-analytics-cta="compress_pdf" data-analytics-surface="home">Compress a PDF <ArrowRight size={17} /></Link>
    </section>
  </AppShell>;
}
