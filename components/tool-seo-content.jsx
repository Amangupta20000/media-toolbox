import { normalizeSitePath } from "../lib/site-metadata.js";
import { TOOL_SEO_CONTENT } from "../lib/tool-seo-content.js";

export function ToolSeoContent({ pathname }) {
  const content = TOOL_SEO_CONTENT[normalizeSitePath(pathname)];
  if (!content) return null;

  return <section className="tool-seo-content" aria-labelledby="tool-seo-title">
    <div className="tool-seo-intro">
      <div className="section-kicker"><span className="kicker-line" /> Helpful guide</div>
      <h2 id="tool-seo-title">About {content.name}</h2>
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
    <article className="tool-seo-faq" aria-labelledby="tool-seo-faq-title">
      <h2 id="tool-seo-faq-title">Frequently asked questions</h2>
      <div className="tool-seo-faq-list">
        {content.faqs.map(([question, answer]) => <div className="tool-seo-faq-item" key={question}>
          <h3>{question}</h3>
          <p>{answer}</p>
        </div>)}
      </div>
    </article>
  </section>;
}
