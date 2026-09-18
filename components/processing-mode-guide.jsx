"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Download, Globe2, Laptop, ShieldCheck, Sparkles } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { PROCESSING_MODE_GUIDE } from "../lib/processing-mode-guide.js";
import { AUTHOR_NAME } from "../lib/site-metadata.js";

function ProcessingFlowDiagram() {
  return <figure className="mode-guide-flow">
    <div className="mode-guide-flow-heading"><span>Two ways to process</span><small>choose the path that fits the file</small></div>
    <svg viewBox="0 0 960 310" role="img" aria-labelledby="mode-guide-flow-title mode-guide-flow-description">
      <title id="mode-guide-flow-title">Browser mode and Local agent processing paths</title>
      <desc id="mode-guide-flow-description">Browser mode processes supported files in the browser and creates a download. Local agent sends the work to NativeMedia Agent on the connected desktop, which uses native tools and creates a local result.</desc>
      <defs>
        <linearGradient id="mode-guide-flow-browser" x1="0" x2="1">
          <stop offset="0" stopColor="#55c8c0" />
          <stop offset="1" stopColor="#8fe0d8" />
        </linearGradient>
        <linearGradient id="mode-guide-flow-local" x1="0" x2="1">
          <stop offset="0" stopColor="#6aa9ee" />
          <stop offset="1" stopColor="#55c8c0" />
        </linearGradient>
        <marker id="mode-guide-flow-arrow-browser" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#55c8c0" /></marker>
        <marker id="mode-guide-flow-arrow-local" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#6aa9ee" /></marker>
      </defs>
      <path className="mode-guide-flow-rail mode-guide-flow-rail-browser" d="M260 96H700" />
      <path className="mode-guide-flow-rail mode-guide-flow-rail-local" d="M260 226H340" />
      <path className="mode-guide-flow-rail mode-guide-flow-rail-local" d="M590 226H700" />
      <path className="mode-guide-flow-line mode-guide-flow-line-browser" d="M260 96H700" markerEnd="url(#mode-guide-flow-arrow-browser)" />
      <path className="mode-guide-flow-line mode-guide-flow-line-local" d="M260 226H340" markerEnd="url(#mode-guide-flow-arrow-local)" />
      <path className="mode-guide-flow-line mode-guide-flow-line-local" d="M590 226H700" markerEnd="url(#mode-guide-flow-arrow-local)" />
      <path className="mode-guide-flow-shimmer mode-guide-flow-shimmer-browser" d="M260 96H700" />
      <path className="mode-guide-flow-shimmer mode-guide-flow-shimmer-local-first" d="M260 226H340" />
      <path className="mode-guide-flow-shimmer mode-guide-flow-shimmer-local-second" d="M590 226H700" />
      <circle className="mode-guide-flow-packet-ring mode-guide-flow-packet-ring-browser" cx="280" cy="96" r="11" />
      <circle className="mode-guide-flow-dot mode-guide-flow-dot-browser" cx="280" cy="96" r="6" />
      <path className="mode-guide-flow-packet-glyph mode-guide-flow-packet-glyph-browser" d="M276 92l8 4-8 4z" />
      <circle className="mode-guide-flow-packet-ring mode-guide-flow-packet-ring-local-first" cx="280" cy="226" r="11" />
      <circle className="mode-guide-flow-dot mode-guide-flow-dot-local-first" cx="280" cy="226" r="6" />
      <path className="mode-guide-flow-packet-glyph mode-guide-flow-packet-glyph-local-first" d="M276 222l8 4-8 4z" />
      <circle className="mode-guide-flow-packet-ring mode-guide-flow-packet-ring-local-second" cx="610" cy="226" r="11" />
      <circle className="mode-guide-flow-dot mode-guide-flow-dot-local-second" cx="610" cy="226" r="6" />
      <path className="mode-guide-flow-packet-glyph mode-guide-flow-packet-glyph-local-second" d="M606 222l8 4-8 4z" />
      <g className="mode-guide-flow-node mode-guide-flow-node-browser">
        <rect x="24" y="44" width="236" height="104" rx="18" />
        <rect className="mode-guide-flow-node-glow mode-guide-flow-node-glow-browser-source" x="24" y="44" width="236" height="104" rx="18" />
        <circle cx="62" cy="83" r="18" />
        <path d="M53 81h18M62 72v18" />
        <text x="94" y="84">Browser mode</text>
        <text x="94" y="109">No installation</text>
      </g>
      <g className="mode-guide-flow-node mode-guide-flow-node-browser">
        <rect x="700" y="44" width="236" height="104" rx="18" />
        <rect className="mode-guide-flow-node-glow mode-guide-flow-node-glow-browser-result" x="700" y="44" width="236" height="104" rx="18" />
        <circle cx="738" cy="83" r="18" />
        <path d="M729 83h18M738 74v18" />
        <text x="770" y="84">Download</text>
        <text x="770" y="109">temporary result</text>
      </g>
      <g className="mode-guide-flow-node mode-guide-flow-node-local">
        <rect x="24" y="174" width="236" height="104" rx="18" />
        <rect className="mode-guide-flow-node-glow mode-guide-flow-node-glow-local-source" x="24" y="174" width="236" height="104" rx="18" />
        <circle cx="62" cy="213" r="18" />
        <path d="M52 206h20v14H52zM56 225h12" />
        <text x="94" y="214">Local agent</text>
        <text x="94" y="239">Connected desktop</text>
      </g>
      <g className="mode-guide-flow-node mode-guide-flow-node-local mode-guide-flow-node-emphasized">
        <rect x="340" y="174" width="250" height="104" rx="18" />
        <rect className="mode-guide-flow-node-glow mode-guide-flow-node-glow-local-tools" x="340" y="174" width="250" height="104" rx="18" />
        <circle className="mode-guide-flow-hub-pulse mode-guide-flow-hub-pulse-one" cx="378" cy="213" r="25" />
        <circle className="mode-guide-flow-hub-pulse mode-guide-flow-hub-pulse-two" cx="378" cy="213" r="25" />
        <circle cx="378" cy="213" r="18" />
        <path d="M369 213h18M378 204v18" />
        <text x="410" y="214">Native tools</text>
        <text x="410" y="239">OCR · PDF · FFmpeg</text>
      </g>
      <g className="mode-guide-flow-node mode-guide-flow-node-local">
        <rect x="700" y="174" width="236" height="104" rx="18" />
        <rect className="mode-guide-flow-node-glow mode-guide-flow-node-glow-local-result" x="700" y="174" width="236" height="104" rx="18" />
        <circle cx="738" cy="213" r="18" />
        <path d="M728 213l7 7 13-15" />
        <text x="770" y="214">Local result</text>
        <text x="770" y="239">save or download</text>
      </g>
    </svg>
    <figcaption>Browser mode keeps supported quick work in the current tab. Local agent runs advanced work on the computer you connect.</figcaption>
  </figure>;
}

function handleGuideNavigation(event, id) {
  const section = document.getElementById(id);
  const navigation = event.currentTarget.closest(".mode-guide-toc");
  if (!section || !navigation) return;
  event.preventDefault();
  const topbarHeight = document.querySelector(".topbar")?.getBoundingClientRect().height || 0;
  const stickyTop = Number.parseFloat(window.getComputedStyle(navigation).top);
  const offsetTop = Number.isFinite(stickyTop) ? stickyTop : topbarHeight;
  const targetTop = Math.max(0, section.getBoundingClientRect().top + window.scrollY - offsetTop - navigation.getBoundingClientRect().height - 24);
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  window.history.replaceState(null, "", `#${id}`);
  window.scrollTo({ top: targetTop, behavior: reduceMotion ? "auto" : "smooth" });
}

function OnThisPage({ activeId }) {
  return <nav className="mode-guide-toc" aria-label="On this page">
    <div className="mode-guide-toc-heading"><span>On this page</span><small>Jump to a section</small></div>
    <div className="mode-guide-toc-links">{PROCESSING_MODE_GUIDE.navigation.map(([id, label]) => <a href={`#${id}`} title={label} className={activeId === id ? "active" : ""} aria-current={activeId === id ? "location" : undefined} onClick={(event) => handleGuideNavigation(event, id)} key={id}>{label}<ArrowRight size={14} aria-hidden="true" /></a>)}</div>
  </nav>;
}

function useActiveSection() {
  const [activeId, setActiveId] = useState(PROCESSING_MODE_GUIDE.navigation[0][0]);

  useEffect(() => {
    if (typeof IntersectionObserver !== "function") return undefined;
    const sections = PROCESSING_MODE_GUIDE.navigation.map(([id]) => document.getElementById(id)).filter(Boolean);
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]?.target.id) setActiveId(visible[0].target.id);
    }, { rootMargin: "-18% 0px -55% 0px", threshold: [0, 1] });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return activeId;
}

function ComparisonTable() {
  return <div className="mode-guide-table-wrap"><table className="mode-guide-table">
    <caption>General differences between Browser mode and Local agent</caption>
    <thead><tr><th scope="col">Comparison</th><th scope="col"><span className="mode-guide-table-title"><Globe2 size={15} aria-hidden="true" /> Browser mode</span></th><th scope="col"><span className="mode-guide-table-title"><Laptop size={15} aria-hidden="true" /> Local agent</span></th></tr></thead>
    <tbody>{PROCESSING_MODE_GUIDE.comparison.map(([label, browser, local]) => <tr key={label}><th scope="row">{label}</th><td>{browser}</td><td>{local}</td></tr>)}</tbody>
  </table></div>;
}

function ToolComparisonTable() {
  return <div className="mode-guide-table-wrap"><table className="mode-guide-table mode-guide-tool-table">
    <caption>Current Browser mode and Local agent support by tool</caption>
    <thead><tr><th scope="col">Tool</th><th scope="col">Browser mode</th><th scope="col">Local agent</th><th scope="col">Recommended choice</th></tr></thead>
    <tbody>{PROCESSING_MODE_GUIDE.tools.map((tool) => <tr key={tool.name}><th scope="row"><Link href={tool.href} title={`Open ${tool.name}`}>{tool.name}</Link></th><td>{tool.browser}</td><td>{tool.local}</td><td>{tool.recommendation}</td></tr>)}</tbody>
  </table></div>;
}

function ChoiceCard({ local = false, title, items }) {
  return <article className={`mode-guide-choice-card ${local ? "local" : "browser"}`}>
    <div className="mode-guide-choice-icon">{local ? <Laptop size={22} aria-hidden="true" /> : <Globe2 size={22} aria-hidden="true" />}</div>
    <div><h3>{title}</h3><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>
  </article>;
}

function GuideFaqs() {
  const [openIndex, setOpenIndex] = useState(0);
  return <div className="mode-guide-faq-list">{PROCESSING_MODE_GUIDE.faqs.map(([question, answer], index) => <article className="mode-guide-faq-item" key={question}>
    <h3><button type="button" aria-expanded={openIndex === index} aria-controls={`mode-guide-faq-${index}`} onClick={() => setOpenIndex((current) => current === index ? -1 : index)}><span>{question}</span><ArrowRight size={16} aria-hidden="true" /></button></h3>
    {openIndex === index && <p id={`mode-guide-faq-${index}`}>{answer}</p>}
  </article>)}</div>;
}

export function ProcessingModeGuide() {
  const activeId = useActiveSection();
  return <AppShell>
    <article className="mode-guide-page">
      <header className="mode-guide-hero">
        <div className="section-kicker"><span className="kicker-line" /> Choose how files run</div>
        <h1>Browser Mode vs Local Agent</h1>
        <p className="mode-guide-hero-copy">Choose the right processing path for your file, privacy needs, and workflow.</p>
        <ProcessingFlowDiagram />
        <p className="mode-guide-summary">Use Browser mode for quick supported tasks without installation. Use Local agent for larger files, advanced PDF features, OCR, video repair, and full desktop processing.</p>
        <p className="mode-guide-updated">Written by <strong>{AUTHOR_NAME}</strong><span aria-hidden="true"> · </span>Last updated: <time dateTime={PROCESSING_MODE_GUIDE.lastUpdated}>{PROCESSING_MODE_GUIDE.lastUpdatedLabel}</time></p>
      </header>

      <OnThisPage activeId={activeId} />

      <section id="overview" className="mode-guide-section" aria-labelledby="mode-guide-overview-title">
        <div className="mode-guide-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Overview</div><h2 id="mode-guide-overview-title">Two processing paths, one untouched original</h2></div><ShieldCheck size={28} aria-hidden="true" /></div>
        <p>Browser mode and Local agent are complementary. Browser mode is the fastest way to handle a supported small task in the current browser. Local agent is the better fit when a job needs native desktop tools, larger limits, or advanced editing.</p>
        <div className="mode-guide-highlight"><CheckCircle2 size={18} aria-hidden="true" /><span>Both modes create a new result and leave your original file untouched.</span></div>
      </section>

      <section id="comparison" className="mode-guide-section" aria-labelledby="mode-guide-comparison-title">
        <div className="mode-guide-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> General comparison</div><h2 id="mode-guide-comparison-title">See the difference at a glance</h2></div></div>
        <ComparisonTable />
      </section>

      <section id="choose" className="mode-guide-section" aria-labelledby="mode-guide-choose-title">
        <div className="mode-guide-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Make the choice</div><h2 id="mode-guide-choose-title">Which option should I choose?</h2></div><Sparkles size={28} aria-hidden="true" /></div>
        <div className="mode-guide-choice-grid">
          <ChoiceCard title="Choose Browser mode when" items={["You need a quick supported task.", "You do not want to install an application.", "Your file is within the browser limit.", "You want a download-only result.", "You are using a supported desktop or mobile browser."]} />
          <ChoiceCard local title="Choose Local agent when" items={["Your file is large or complex.", "You need OCR, video repair, advanced PDF tools, or full format support.", "You want Local-agent History or device retention.", "You prefer native desktop processing.", "You need the more reliable option for an advanced job."]} />
        </div>
        <div className="mode-guide-decision-note"><ShieldCheck size={18} aria-hidden="true" /><span>If you are unsure, start with Browser mode for a small supported file. Switch to Local agent when the tool shows a limit or feature restriction.</span></div>
      </section>

      <section id="tool-comparison" className="mode-guide-section" aria-labelledby="mode-guide-tools-title">
        <div className="mode-guide-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Tool-by-tool comparison</div><h2 id="mode-guide-tools-title">Choose based on the actual task</h2><p>Limits and feature support below reflect the current tool behavior. Check the tool page before a large or advanced job.</p></div></div>
        <ToolComparisonTable />
      </section>

      <section id="how-it-works" className="mode-guide-section" aria-labelledby="mode-guide-how-title">
        <div className="mode-guide-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Product guide</div><h2 id="mode-guide-how-title">How processing works</h2></div></div>
        <div className="mode-guide-steps">{[
          ["01", "Choose a tool", "Open the image, SVG, video, or PDF tool that matches your job."],
          ["02", "Select a mode", "Use Browser mode for supported quick work, or Local agent for larger and advanced jobs."],
          ["03", "Add your file", "Review the displayed format, size, and page limits before starting."],
          ["04", "Process the file", "The selected location performs the job and creates a new result."],
          ["05", "Review and download", "Check the result and download it. Local agent can retain it only when you choose to save it."],
        ].map(([number, title, description]) => <article key={number}><span>{number}</span><div><h3>{title}</h3><p>{description}</p></div></article>)}</div>
        <div className="mode-guide-privacy-note"><ShieldCheck size={18} aria-hidden="true" /><div><strong>Privacy depends on the selected location</strong><p>Browser mode keeps supported files in the browser session. Local agent keeps processing on the connected computer. If Server mode is explicitly shown by a deployment, selected files are sent to that configured server and follow its processing rules.</p></div></div>
      </section>

      <section id="faq" className="mode-guide-section" aria-labelledby="mode-guide-faq-title">
        <div className="mode-guide-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Questions answered</div><h2 id="mode-guide-faq-title">Frequently asked questions</h2></div></div>
        <GuideFaqs />
      </section>

      <section id="start" className="mode-guide-start" aria-labelledby="mode-guide-start-title">
        <div><div className="section-kicker"><span className="kicker-line" /> Ready to begin?</div><h2 id="mode-guide-start-title">Start with the option that fits your file</h2><p>Try a supported Browser-mode tool, or install the Local agent for advanced desktop processing.</p></div>
        <div className="mode-guide-start-actions"><Link className="primary-button" href="/image-converter" title="Open Browser mode image converter" data-analytics-cta="try_browser_mode" data-analytics-surface="processing_mode_guide"><Globe2 size={17} /> Try Browser mode</Link><Link className="secondary-button" href="/local-agent" title="Open Local agent" data-analytics-cta="open_local_agent" data-analytics-surface="processing_mode_guide"><Laptop size={17} /> Open Local agent</Link><Link className="mode-guide-text-link" href="/how-to-setup-agent" title="View Local agent setup guide"><Download size={15} /> View setup guide</Link></div>
      </section>
    </article>
  </AppShell>;
}
