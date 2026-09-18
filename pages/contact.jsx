import { Mail } from "lucide-react";
import { AppShell } from "../components/app-shell.jsx";
import { AUTHOR_EMAIL, AUTHOR_NAME, PRODUCT_NAME } from "../lib/site-metadata.js";

export function getMonthStartIso(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

function formatMonthStart(dateIso) {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${dateIso}T00:00:00Z`));
}

export default function ContactPage({ updatedAt }) {
  return <AppShell>
    <article className="legal-document contact-document">
      <div className="section-kicker"><span className="kicker-line" /> Contact</div>
      <h1>Contact Us</h1>
      <p className="legal-meta">Last updated: <time dateTime={updatedAt}>{formatMonthStart(updatedAt)}</time></p>

      <section className="contact-card" aria-labelledby="get-in-touch-heading">
        <div className="contact-heading">
          <span className="contact-icon"><Mail size={34} aria-hidden="true" /></span>
          <h2 id="get-in-touch-heading">Get in Touch</h2>
        </div>
        <p>Have a question, suggestion, or feedback? We would love to hear from you.</p>
        <a className="contact-email-link" href={`mailto:${AUTHOR_EMAIL}`}>
          <Mail size={22} aria-hidden="true" />
          <span>{AUTHOR_EMAIL}</span>
        </a>
        <h2>What to include</h2>
        <p>For a bug report, include the tool or page, browser and operating system, and the steps that reproduce the issue. Please do not email files containing personal or confidential information, credentials, activation codes, or license/device identifiers unless we specifically request them and you are authorized to share them.</p>
        <p>Privacy, data-access, correction, erasure, and consent questions can also be sent to this address. See the <a href="/privacy">Privacy Policy</a> for details.</p>
        <p className="contact-operator">{PRODUCT_NAME} is operated by {AUTHOR_NAME}.</p>
      </section>
    </article>
  </AppShell>;
}

export function getServerSideProps() {
  return { props: { updatedAt: getMonthStartIso() } };
}
