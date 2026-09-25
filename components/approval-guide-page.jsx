import Link from "next/link";
import { ArrowRight, BookOpen, ShieldCheck } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { AUTHOR_NAME, CONTENT_LAST_UPDATED } from "../lib/site-metadata.js";
import { GUIDE_INDEX } from "../lib/approval-guides.js";

function GuideByline({ lastUpdated }) {
  return <p className="approval-guide-byline">Written by <strong>{AUTHOR_NAME}</strong><span aria-hidden="true"> · </span>Last updated: <time dateTime={lastUpdated}>{lastUpdated}</time></p>;
}

function GuideSection({ section }) {
  return <section className="approval-guide-section" aria-labelledby={`guide-section-${section.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>
    <h2 id={`guide-section-${section.heading.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}>{section.heading}</h2>
    {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
    {section.steps?.length > 0 && <ol>{section.steps.map((step) => <li key={step}>{step}</li>)}</ol>}
    {section.bullets?.length > 0 && <ul>{section.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}
  </section>;
}

function GuideFaqs({ faqs }) {
  return <section className="approval-guide-section approval-guide-faq" aria-labelledby="approval-guide-faq-title">
    <h2 id="approval-guide-faq-title">Frequently asked questions</h2>
    <div className="approval-guide-faq-list">
      {faqs.map(([question, answer], index) => <details key={question} open={index === 0}>
        <summary>{question}</summary>
        <p>{answer}</p>
      </details>)}
    </div>
  </section>;
}

export function ApprovalGuidePage({ guide }) {
  if (!guide) return null;

  return <AppShell>
    <article className="approval-guide-page">
      <header className="approval-guide-hero">
        <div className="section-kicker"><span className="kicker-line" /> {guide.eyebrow}</div>
        <h1>{guide.title}</h1>
        <p className="approval-guide-summary">{guide.summary}</p>
        <GuideByline lastUpdated={guide.lastUpdated} />
        <div className="approval-guide-hero-note"><ShieldCheck size={18} aria-hidden="true" /><span>Use the tool that matches your file and check the exported result before replacing the original.</span></div>
      </header>

      <div className="approval-guide-layout">
        <div className="approval-guide-content">
          {guide.sections.map((section) => <GuideSection key={section.heading} section={section} />)}
          <GuideFaqs faqs={guide.faqs} />
        </div>
        <aside className="approval-guide-related" aria-labelledby="approval-guide-related-title">
          <div className="approval-guide-related-heading"><BookOpen size={18} aria-hidden="true" /><strong id="approval-guide-related-title">Use this guide with</strong></div>
          <div className="approval-guide-related-links">{guide.relatedLinks.map(([href, label, detail]) => <Link href={href} key={href}><span><strong>{label}</strong><small>{detail}</small></span><ArrowRight size={16} aria-hidden="true" /></Link>)}</div>
          <Link className="secondary-button approval-guide-back" href="/guides">Browse all guides <ArrowRight size={15} /></Link>
        </aside>
      </div>
    </article>
  </AppShell>;
}

export function ApprovalGuidesHub() {
  return <AppShell>
    <article className="approval-guides-hub">
      <header className="approval-guide-hero">
        <div className="section-kicker"><span className="kicker-line" /> Practical guides</div>
        <h1>Guides for private PDF and media workflows</h1>
        <p className="approval-guide-summary">Learn how to choose the right tool, understand the limits, and check the result before you share or replace an original file.</p>
        <GuideByline lastUpdated={CONTENT_LAST_UPDATED} />
      </header>
      <div className="approval-guides-grid">
        {GUIDE_INDEX.map((guide) => <Link className="approval-guide-card" href={guide.path} key={guide.path}>
          <span className="section-kicker"><span className="kicker-line" /> {guide.eyebrow}</span>
          <h2>{guide.title}</h2>
          <p>{guide.summary}</p>
          <span className="approval-guide-card-link">Read guide <ArrowRight size={15} /></span>
        </Link>)}
      </div>
    </article>
  </AppShell>;
}
