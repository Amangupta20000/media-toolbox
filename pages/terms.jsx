import { AppShell } from "../components/app-shell.jsx";

export default function TermsPage() {
  return <AppShell>
    <article className="legal-document">
      <div className="section-kicker"><span className="kicker-line" /> Terms</div>
      <h1>Terms and Conditions</h1>
      <p className="legal-intro">These terms describe the basic rules for using Media Toolbox and its local processing agent.</p>
      <p className="legal-meta">Last updated: <time dateTime="2026-09-15">September 15, 2026</time></p>

      <h2>Using the service</h2>
      <p>You may use Media Toolbox only for lawful purposes and only with files you are authorized to process. You are responsible for reviewing generated files before relying on or sharing them.</p>

      <h2>Local agent and licensing</h2>
      <p>The local agent runs on devices where you install and authorize it. You must keep your device, operating system, networking tools, and licensing credentials secure. Access may be limited, suspended, or revoked when required to protect the service or enforce a license.</p>

      <h2>Prohibited use</h2>
      <p>You must not use the service to infringe rights, distribute malware, evade access controls, interfere with another user or system, or attempt to reverse engineer or abuse the licensing and processing infrastructure.</p>

      <h2>Results and availability</h2>
      <p>Media Toolbox is provided on an as-available basis. Processing may fail, produce an imperfect result, or be unavailable because of file contents, system dependencies, connectivity, or maintenance. Keep an original copy of important files.</p>

      <h2>Changes and termination</h2>
      <p>Features, releases, limits, and these terms may change as the project evolves. You may stop using the service at any time. Access can be suspended when continued use creates a security, licensing, or operational risk.</p>

      <h2>Questions</h2>
      <p>For questions about these terms or a particular Media Toolbox deployment, contact the operator who provided that deployment.</p>
    </article>
  </AppShell>;
}
