import { AppShell } from "../components/app-shell.jsx";

export default function PrivacyPolicyPage() {
  return <AppShell>
    <article className="legal-document">
      <div className="section-kicker"><span className="kicker-line" /> Privacy</div>
      <h1>Privacy Policy</h1>
      <p className="legal-intro">Media Toolbox is designed to keep everyday media work private and understandable.</p>
      <p className="legal-meta">Last updated: <time dateTime="2026-09-15">September 15, 2026</time></p>

      <h2>Operator and contact</h2>
      <p>Media Toolbox is operated by Aman Gupta. For privacy questions or requests about this website and the Local agent, contact <a href="mailto:a20000.gupta@gmail.com">a20000.gupta@gmail.com</a>.</p>

      <h2>What Media Toolbox processes</h2>
      <p>The current release performs file conversion, repair, PDF editing, compression, and OCR through the connected Media Toolbox Local agent on a desktop computer. The Local agent supports macOS, Windows, and Linux. The website provides the control interface and may display previews, but it does not perform the requested file operation itself.</p>

      <h2>Files and results</h2>
      <p>Source files, temporary job data, previews, and generated results are used to complete the requested operation through the Local agent. Source files and Local-agent results stay on the connected desktop computer; results are retained there only when you choose to keep them. Do not select files unless you have the right to process them.</p>

      <h2>Device and licensing information</h2>
      <p>When licensing or pairing is enabled, the service may receive a device identifier, operating system, application version, pairing state, license events, and operational audit records. This information is used to authorize the software, protect the licensing service, troubleshoot connectivity, and maintain an audit trail.</p>

      <h2>Website requests and service providers</h2>
      <p>Website requests can include normal technical information such as IP address, browser type, request time, and error details. Infrastructure and licensing providers may process information needed to deliver the website and licensing features. Their handling is governed by their own policies and the configuration of the deployment.</p>

      <h2>Retention and deletion</h2>
      <p>Temporary data is deleted according to the cleanup rules of the active deployment. Retained local results remain until you remove them. Licensing and audit records may be retained for the period needed to operate, secure, and support the service.</p>

      <h2>Your choices</h2>
      <p>You can connect the Local agent on a supported macOS, Windows, or Linux desktop, choose whether to retain generated results, remove local history, and stop using the website. For questions about a specific deployment, contact its operator.</p>
    </article>
  </AppShell>;
}
