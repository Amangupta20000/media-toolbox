"use client";

import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { AUTHOR_NAME, CONTENT_LAST_UPDATED, metadataForPathname, normalizeSitePath } from "../lib/site-metadata.js";
import { TOOL_SEO_CONTENT } from "../lib/tool-seo-content.js";

export function ToolSeoContent({ pathname }) {
  const content = TOOL_SEO_CONTENT[normalizeSitePath(pathname)];
  if (!content) return null;
  const relatedLinks = [
    ...(content.relatedLinks || []),
    ["/browser-vs-local-agent", "Browser vs Local agent", "Compare privacy, limits, and feature support before choosing a mode."],
    ["/guides", "Read the practical guides", "Learn how to choose a workflow and check the exported result."],
  ].filter(([href], index, links) => !metadataForPathname(href).noIndex && links.findIndex(([candidate]) => candidate === href) === index);

  return <section id="tool-guide" className="tool-seo-content" aria-labelledby="tool-seo-title">
    <div className="tool-seo-intro">
      <div className="section-kicker"><span className="kicker-line" /> Helpful guide</div>
      <h2 id="tool-seo-title">{content.introHeading || `About ${content.name}`}</h2>
      <p>{content.intro}</p>
      <p className="tool-seo-byline">Written by <strong>{AUTHOR_NAME}</strong><span aria-hidden="true"> · </span>Last updated: <time dateTime={CONTENT_LAST_UPDATED}>{CONTENT_LAST_UPDATED}</time></p>
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
          <thead><tr>{(content.comparisonHeaders || ["Feature", "Browser mode", "Local agent"]).map((header) => <th key={header}>{header}</th>)}</tr></thead>
          <tbody>{content.comparison.map(([feature, ...values]) => <tr key={feature}><th scope="row">{feature}</th>{values.map((value, index) => <td key={`${feature}-${index}`}>{value}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </section>}
    {relatedLinks.length > 0 && <nav className="tool-seo-related" aria-labelledby="tool-seo-related-title">
      <h2 id="tool-seo-related-title">Related tools and guides</h2>
      <div className="tool-seo-related-grid">{relatedLinks.map(([href, label, detail]) => <Link className="tool-seo-related-link" href={href} key={href}><span><strong>{label}</strong><small>{detail}</small></span><span aria-hidden="true">→</span></Link>)}</div>
    </nav>}
  </section>;
}

function FaqSection({ content }) {
  return <article className="tool-seo-faq" aria-labelledby="tool-seo-faq-title">
    <h2 id="tool-seo-faq-title">Frequently asked questions</h2>
    <div className="tool-seo-faq-list">
      {content.faqs.map(([question, answer], index) => <details className="tool-seo-faq-item" key={question} open={index === 0}>
        <summary className="tool-seo-faq-question">
          <span>{question}</span>
          <ChevronDown size={17} aria-hidden="true" />
        </summary>
        <p id={`tool-seo-faq-answer-${index}`} className="tool-seo-faq-answer">{answer}</p>
      </details>)}
    </div>
  </article>;
}

export function ToolFaqContent({ pathname }) {
  const content = TOOL_SEO_CONTENT[normalizeSitePath(pathname)];
  if (!content?.faqs?.length) return null;

  return <section className="tool-seo-content tool-faq-content" aria-label={`${content.name} frequently asked questions`}>
    <FaqSection content={content} />
  </section>;
}
