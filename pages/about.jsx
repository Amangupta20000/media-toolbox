import Link from "next/link";
import { ArrowRight, CheckCircle2, Mail, ShieldCheck } from "lucide-react";
import { AppShell } from "../components/app-shell.jsx";
import { AUTHOR_EMAIL, AUTHOR_NAME, CONTENT_LAST_UPDATED, PRODUCT_NAME } from "../lib/site-metadata.js";

export default function AboutPage() {
  return <AppShell>
    <article className="about-page">
      <header className="about-hero">
        <div className="section-kicker"><span className="kicker-line" /> About the project</div>
        <h1>Practical private tools for everyday files</h1>
        <p>{PRODUCT_NAME} is maintained by {AUTHOR_NAME} to make common image, video, and PDF tasks easier to understand and safer to run on the computer where the files already live.</p>
        <p className="approval-guide-byline">Written by <strong>{AUTHOR_NAME}</strong><span aria-hidden="true"> · </span>Last updated: <time dateTime={CONTENT_LAST_UPDATED}>{CONTENT_LAST_UPDATED}</time></p>
      </header>

      <div className="about-grid">
        <section className="about-card">
          <h2>Why this project exists</h2>
          <p>Many file tasks are simple in principle but difficult to compare: the right format, page limit, output quality, and privacy behavior are often unclear until after a job starts. NativeMedia Agent puts those choices next to the tool and explains what the exported result contains.</p>
          <p>The project is intentionally focused on practical utilities rather than a large collection of automatic pages. Each supported workflow should tell you what it accepts, where processing happens, what changes, and how to check the result.</p>
        </section>
        <section className="about-card">
          <h2>How processing works</h2>
          <ul className="about-check-list">
            <li><CheckCircle2 size={17} aria-hidden="true" /> Browser mode handles supported quick work in the current browser.</li>
            <li><CheckCircle2 size={17} aria-hidden="true" /> Local agent uses native tools on the connected Mac, Windows, or Linux computer.</li>
            <li><CheckCircle2 size={17} aria-hidden="true" /> The workflows create new results and leave source files untouched.</li>
            <li><CheckCircle2 size={17} aria-hidden="true" /> The selected processing location and relevant limits are shown before submission.</li>
          </ul>
        </section>
        <section className="about-card">
          <h2>How the information is maintained</h2>
          <p>Tool instructions are based on the current behavior of the website and Local agent. Limits, supported formats, and processing differences are reviewed when the workflows change. The guides describe practical use cases and known limitations rather than promising that every file can be repaired or converted perfectly.</p>
          <p>When a result matters, keep the original and verify the new file in the application where it will be used.</p>
        </section>
        <section className="about-card about-contact-card">
          <h2>Contact the owner</h2>
          <p>Send questions, bug reports, corrections, and privacy requests to the project owner.</p>
          <a className="secondary-button" href={`mailto:${AUTHOR_EMAIL}`}><Mail size={16} /> {AUTHOR_EMAIL}</a>
        </section>
      </div>

      <section className="about-links" aria-labelledby="about-links-title">
        <div><div className="section-kicker"><span className="kicker-line" /> Continue reading</div><h2 id="about-links-title">Understand the workflow before using a tool</h2></div>
        <div className="about-link-grid">
          <Link href="/guides">Browse the practical guides <ArrowRight size={15} /></Link>
          <Link href="/browser-vs-local-agent">Compare processing modes <ArrowRight size={15} /></Link>
          <Link href="/privacy">Read the privacy policy <ShieldCheck size={15} /></Link>
        </div>
      </section>
    </article>
  </AppShell>;
}
