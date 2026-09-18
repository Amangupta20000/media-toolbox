"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { normalizeSitePath } from "../lib/site-metadata.js";
import { TOOL_SEO_CONTENT } from "../lib/tool-seo-content.js";

export function ToolSeoContent({ pathname }) {
  const content = TOOL_SEO_CONTENT[normalizeSitePath(pathname)];
  if (!content) return null;
  const relatedLinks = [
    ...(content.relatedLinks || []),
    ["/browser-vs-local-agent", "Browser vs Local agent", "Compare privacy, limits, and feature support before choosing a mode."],
  ];

  return <section className="tool-seo-content" aria-labelledby="tool-seo-title">
    <div className="tool-seo-intro">
      <div className="section-kicker"><span className="kicker-line" /> Helpful guide</div>
      <h2 id="tool-seo-title">{content.introHeading || `About ${content.name}`}</h2>
      <p>{content.intro}</p>
    </div>
    <div className="tool-seo-grid">
      <article className="tool-seo-panel">
        <h2>How to use {content.name}</h2>
        <ol>{content.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      </article>
      <article className="tool-seo-panel tool-seo-trust">
        <h2>Privacy and file safety</h2>
        <ul>{content.trust.map((item) => <li key={item}>{item}</li>)}</ul>
      </article>
    </div>
    {content.comparison?.length > 0 && <section className="tool-seo-comparison" aria-labelledby="tool-seo-comparison-title">
      <h2 id="tool-seo-comparison-title">At a glance</h2>
      <div className="tool-seo-comparison-scroll">
        <table>
          <thead><tr><th>Feature</th><th>Browser mode</th><th>Local agent</th></tr></thead>
          <tbody>{content.comparison.map(([feature, browser, local]) => <tr key={feature}><th scope="row">{feature}</th><td>{browser}</td><td>{local}</td></tr>)}</tbody>
        </table>
      </div>
    </section>}
    {relatedLinks.length > 0 && <nav className="tool-seo-related" aria-labelledby="tool-seo-related-title">
      <h2 id="tool-seo-related-title">Related tools and guides</h2>
      <div className="tool-seo-related-grid">{relatedLinks.map(([href, label, detail]) => <Link className="tool-seo-related-link" href={href} key={href}><span><strong>{label}</strong><small>{detail}</small></span><span aria-hidden="true">→</span></Link>)}</div>
    </nav>}
  </section>;
}

function FaqSection({ content, openFaqIndex, setOpenFaqIndex }) {
  return <article className="tool-seo-faq" aria-labelledby="tool-seo-faq-title">
    <h2 id="tool-seo-faq-title">Frequently asked questions</h2>
    <div className="tool-seo-faq-list">
      {content.faqs.map(([question, answer], index) => <article className="tool-seo-faq-item" key={question}>
        <button className="tool-seo-faq-question" type="button" aria-expanded={openFaqIndex === index} aria-controls={`tool-seo-faq-answer-${index}`} onClick={() => setOpenFaqIndex((current) => current === index ? null : index)}>
          <span>{question}</span>
          <ChevronDown size={17} aria-hidden="true" />
        </button>
        {openFaqIndex === index && <p id={`tool-seo-faq-answer-${index}`} className="tool-seo-faq-answer">{answer}</p>}
      </article>)}
    </div>
  </article>;
}

export function ToolFaqContent({ pathname }) {
  const content = TOOL_SEO_CONTENT[normalizeSitePath(pathname)];
  const [openFaqIndex, setOpenFaqIndex] = useState(0);
  if (!content?.faqs?.length) return null;

  return <section className="tool-seo-content tool-faq-content" aria-label={`${content.name} frequently asked questions`}>
    <FaqSection content={content} openFaqIndex={openFaqIndex} setOpenFaqIndex={setOpenFaqIndex} />
  </section>;
}
