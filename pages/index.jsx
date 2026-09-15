import Link from "next/link";
import { Archive, ArrowRight, Bot, Check, FileText, Film, Image as ImageIcon, ShieldCheck } from "lucide-react";
import { AppShell } from "../components/app-shell.jsx";

const toolDirectory = [
  { href: "/pdf-editor", label: "PDF editor", description: "Merge PDFs, arrange pages, and add images or text boxes.", icon: FileText, category: "PDF tools" },
  { href: "/pdf-text-editor", label: "PDF text editor", description: "Edit searchable PDF text with OCR-assisted selection for scans.", icon: FileText, category: "PDF tools" },
  { href: "/pdf-compressor", label: "PDF compressor", description: "Shrink large PDFs with selectable quality and image settings.", icon: Archive, category: "PDF tools" },
  { href: "/image-converter", label: "Image converter", description: "Convert JPG, PNG, HEIC, TIFF, GIF, and BMP files.", icon: ImageIcon, category: "Media tools" },
  { href: "/video-repair", label: "Video repair", description: "Recover readable video files with layered repair methods.", icon: Film, category: "Media tools" },
  { href: "/local-agent", label: "Local agent", description: "Process supported files on your own Mac, Windows, or Linux computer.", icon: Bot, category: "Private processing" },
];

const principles = [
  ["Choose where files run", "Use the browser where supported or the connected Local agent for on-device processing."],
  ["Keep originals untouched", "Every conversion, repair, or PDF edit creates a new result instead of overwriting your source."],
  ["Understand retention", "Temporary Local agent data follows the agent cleanup rules, and local results are retained only when you choose."],
];

export default function HomePage() {
  return <AppShell>
    <section className="home-hero" aria-labelledby="home-title">
      <div className="section-kicker"><span className="kicker-line" /> Private file tools</div>
      <h1 id="home-title">Private PDF and media tools for your desktop</h1>
      <p>Convert images, repair videos, edit PDFs, and reduce document size with Media Toolbox. Connect the Local agent on macOS, Windows, or Linux to keep processing on your computer and your original files untouched.</p>
      <div className="home-actions">
        <Link className="primary-button" href="/pdf-editor">Open PDF editor <ArrowRight size={17} /></Link>
        <Link className="secondary-button" href="/image-converter">Convert an image</Link>
      </div>
      <div className="home-trust-line"><ShieldCheck size={17} /><span>Processing location shown · source files are not overwritten</span></div>
    </section>

    <section className="home-section" aria-labelledby="home-tools-title">
      <div className="home-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Tool directory</div><h2 id="home-tools-title">Choose the tool for your file</h2></div><Link className="text-link" href="/coming-soon">See the roadmap <ArrowRight size={15} /></Link></div>
      <div className="home-tool-grid">
        {toolDirectory.map(({ href, label, description, icon: Icon, category }) => <Link className="home-tool-card" href={href} key={href}>
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
      <Link className="primary-button" href="/pdf-compressor">Compress a PDF <ArrowRight size={17} /></Link>
    </section>
  </AppShell>;
}
