import { AppShell } from "../components/app-shell.jsx";
import { PRODUCT_NAME } from "../lib/site-metadata.js";

export default function TermsPage() {
  return <AppShell>
    <article className="legal-document">
      <div className="section-kicker"><span className="kicker-line" /> Terms</div>
      <h1>Terms and Conditions</h1>
      <p className="legal-intro">These terms describe the basic rules for using the {PRODUCT_NAME} website, Browser mode, Local agent, and any server-backed processing that a deployment makes available.</p>
      <p className="legal-meta">Last updated: <time dateTime="2026-09-18">September 18, 2026</time></p>

      <h2>Operator and contact</h2>
      <p>{PRODUCT_NAME} is operated by Aman Gupta. For questions about these terms or a particular {PRODUCT_NAME} deployment, contact <a href="mailto:a20000.gupta@gmail.com">a20000.gupta@gmail.com</a>.</p>

      <h2>Using the service</h2>
      <p>You may use {PRODUCT_NAME} only for lawful purposes and only with files you are authorized to process. You are responsible for reviewing generated files before relying on or sharing them, and for complying with copyright, confidentiality, privacy, and other rights that apply to your files.</p>

      <h2>Processing modes</h2>
      <p>Browser mode runs supported work in your browser and is subject to its stated file-size, page-count, format, and feature limits. Local agent mode runs supported work on the desktop where you installed the agent. If Server mode is shown as available, you authorize the selected files to be sent to that deployment’s processing server for the requested job. See the <a href="/privacy">Privacy Policy</a> for the related data-handling differences.</p>

      <h2>Local agent and licensing</h2>
      <p>The local agent runs on devices where you install and authorize it. You must keep your device, operating system, networking tools, and licensing credentials secure. Access may be limited, suspended, or revoked when required to protect the service or enforce a license.</p>

      <h2>Prohibited use</h2>
      <p>You must not use the service to infringe rights, distribute malware, evade access controls, interfere with another user or system, or attempt to reverse engineer or abuse the licensing and processing infrastructure.</p>

      <h2>Results and availability</h2>
      <p>{PRODUCT_NAME} is provided on an as-available basis. Processing may fail, produce an imperfect result, or be unavailable because of file contents, system dependencies, connectivity, browser limitations, or maintenance. The tools are general-purpose utilities, not a substitute for professional review. Keep an original copy of important files and verify each result before using it.</p>

      <h2>Third-party services</h2>
      <p>Hosting, licensing, analytics, advertising, and other third-party services may be used to operate a deployment. Those services may have separate terms and privacy policies. Your use of them is subject to the terms presented by the relevant provider and the configuration of the deployment.</p>

      <h2>Changes and termination</h2>
      <p>Features, releases, limits, and these terms may change as the project evolves. You may stop using the service at any time. Access can be suspended when continued use creates a security, licensing, or operational risk.</p>

      <h2>Questions</h2>
      <p>For questions about these terms, privacy, licensing, or a particular deployment, contact <a href="mailto:a20000.gupta@gmail.com">a20000.gupta@gmail.com</a>.</p>
    </article>
  </AppShell>;
}
