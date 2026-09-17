import { AppShell } from "../components/app-shell.jsx";
import { PRODUCT_NAME } from "../lib/site-metadata.js";

export default function PrivacyPolicyPage() {
  return <AppShell>
    <article className="legal-document">
      <div className="section-kicker"><span className="kicker-line" /> Privacy</div>
      <h1>Privacy Policy</h1>
      <p className="legal-intro">{PRODUCT_NAME} is designed to keep everyday media work private and understandable.</p>
      <p className="legal-meta">Last updated: <time dateTime="2026-09-17">September 17, 2026</time></p>

      <h2>Operator and contact</h2>
      <p>{PRODUCT_NAME} is operated by Aman Gupta. For privacy questions or requests about this website and the local agent, contact <a href="mailto:a20000.gupta@gmail.com">a20000.gupta@gmail.com</a>.</p>

      <h2>What {PRODUCT_NAME} processes</h2>
      <p>The current release performs file conversion, repair, PDF editing, compression, and OCR through the connected {PRODUCT_NAME} on a desktop computer. The local agent supports macOS, Windows, and Linux. The website provides the control interface and may display previews, but it does not perform the requested file operation itself.</p>

      <h2>Files and results</h2>
      <p>Source files, temporary job data, previews, and generated results are used to complete the requested operation through the Local agent. Source files and Local-agent results stay on the connected desktop computer; results are retained there only when you choose to keep them. Do not select files unless you have the right to process them.</p>

      <h2>Device and licensing information</h2>
      <p>When licensing or pairing is enabled, the service may receive a device identifier, operating system, application version, pairing state, license events, and operational audit records. This information is used to authorize the software, protect the licensing service, troubleshoot connectivity, and maintain an audit trail.</p>

      <h2>Website requests and service providers</h2>
      <p>Website requests can include normal technical information such as IP address, browser type, request time, and error details. Infrastructure and licensing providers may process information needed to deliver the website and licensing features. Their handling is governed by their own policies and the configuration of the deployment.</p>

      <h2>Analytics and cookies</h2>
      <p>If you accept analytics, this website uses Google Analytics 4 through Google Tag Manager to understand page views and selected interactions with the public website. The analytics data categories are page path and title, tool, processing mode, input type and count, selected action labels, result type, offer ID, and offer-code copy outcome. Google Analytics may also receive standard technical information such as browser/device information and timestamps. Google Analytics may use the first-party <code>_ga</code> cookie and a similar client identifier to distinguish visits. Analytics is denied by default, and we do not send files, file contents, filenames, exact file sizes, license information, or offer codes to Google Analytics. You can accept or reject analytics and change your choice at any time using Manage privacy choices; the preference is retained for six months. The consent cookie records your choice, consent-notice version, and time locally; it is not sent to Google Analytics.</p>

      <h2>AdSense</h2>
      <p>The public website includes Google’s AdSense publisher script for site verification. The verification script alone does not place an ad unit on a page. If advertising is enabled, Google may process standard technical information and advertising-related data under its own policies and the consent settings configured for the site. We do not send files, file contents, filenames, license information, or offer codes to Google through this integration. We will provide the required Google consent controls before serving ads where they are required.</p>

      <h2>Retention and deletion</h2>
      <p>Temporary data is deleted according to the cleanup rules of the active deployment. Retained local results remain until you remove them. Licensing and audit records may be retained for the period needed to operate, secure, and support the service.</p>

      <h2>Your rights and complaints</h2>
      <p>Subject to applicable law, you may withdraw analytics consent at any time through Manage privacy choices. You may also contact <a href="mailto:a20000.gupta@gmail.com">a20000.gupta@gmail.com</a> to ask about processing of your personal data, request correction or erasure where applicable, or raise a privacy grievance. We will use the applicable complaint and response process, and you may use the applicable Data Protection Board process when available if your grievance is not resolved.</p>

      <h2>Your choices</h2>
      <p>You can connect the Local agent on a supported macOS, Windows, or Linux desktop, choose whether to retain generated results, remove local history, and stop using the website. For questions about a specific deployment, contact its operator.</p>
    </article>
  </AppShell>;
}
