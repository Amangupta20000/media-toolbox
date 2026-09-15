import { AudioLines, Captions, FileImage, FileMusic, FileText, FileVideo, Film, GalleryHorizontalEnd, ImagePlus, PenLine, ScanLine, SlidersHorizontal, WandSparkles } from "lucide-react";
import Link from "next/link";
import { AppShell } from "../components/app-shell.jsx";

const plannedTools = [
  ["PDF editor", "Merge PDFs, reorder pages, and add or remove pages in one document.", FileText, "Beta", "/pdf-editor"],
  ["PDF text editor", "Edit text inside PDFs and save a clean, shareable copy.", PenLine, "Beta", "/pdf-text-editor"],
  ["SVG to PNG converter", "Upload an SVG or paste SVG code, then export at 1×, 2×, 3×, 4×, or a custom size with a transparent or color-picked background.", ImagePlus, "Beta", "/svg-to-png"],
  ["Sign images & PDFs", "Create or upload a signature, then place it on an image or PDF page.", PenLine],
  ["Audio converter", "Convert music and audio between MP3, WAV, AAC, FLAC, and more.", AudioLines],
  ["Video compressor", "Reduce video file size while keeping the best practical quality.", FileVideo],
  ["Audio extractor", "Pull a clean audio track from any supported video file.", FileMusic],
  ["GIF maker", "Turn a short video clip or a group of images into an animated GIF.", Film],
  ["Video thumbnails", "Create sharp thumbnail images from any moment in a video.", GalleryHorizontalEnd],
  ["Subtitle tools", "Add, remove, convert, or repair subtitle tracks and captions.", Captions],
  ["Batch image resize", "Resize many images at once for web, social media, or email.", ScanLine],
  ["Image background remover", "Remove a simple background and export a clean cutout.", ImagePlus],
  ["PDF to images", "Convert PDF pages into high-quality JPG or PNG images.", FileImage],
  ["Media cleanup", "Inspect files and remove metadata before sharing them.", SlidersHorizontal],
];

export default function ComingSoonPage() {
  return <AppShell>
    <div className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> Planned tools</div><h1>More tools, on the way</h1><p>We are building a wider set of practical media utilities. These are the next tools planned for the toolbox.</p></div><div className="heading-note"><WandSparkles size={16} /><span>{plannedTools.length} tools planned</span></div></div>
    <section className="coming-soon-hero"><div className="coming-soon-hero-icon"><WandSparkles size={24} /></div><div><h2>Coming soon</h2><p>Each tool will use the same private, temporary processing workflow as the current utilities.</p></div></section>
    <div className="planned-tools-grid">{plannedTools.map(([name, description, Icon, status = "Planned", href], index) => { const card = <><div className="planned-tool-number">{String(index + 1).padStart(2, "0")}</div><div className="planned-tool-icon"><Icon size={21} /></div><div><h2>{name}</h2><p>{description}</p></div><span className={`planned-tool-status ${status.toLowerCase()}`}>{status}</span></>; return href ? <Link className="planned-tool-card" href={href} key={name}>{card}</Link> : <article className="planned-tool-card" key={name}>{card}</article>; })}</div>
  </AppShell>;
}
