import { AppShell } from "../components/app-shell.jsx";
import { PRODUCT_NAME } from "../lib/site-metadata.js";

export default function PrivacyPolicyPage() {
  return <AppShell>
    <article className="legal-document">
      <div className="section-kicker"><span className="kicker-line" /> Privacy</div>
      <h1>Privacy Policy</h1>
      <p className="legal-intro">{PRODUCT_NAME} is designed to keep everyday media work private and understandable. This policy explains what the public website and its available processing modes handle.</p>
      <p className="legal-meta">Last updated: <time dateTime="2026-09-18">September 18, 2026</time></p>

      <h2>Operator and contact</h2>
      <p>{PRODUCT_NAME} is operated by Aman Gupta. For privacy questions or requests about this website and the local agent, contact <a href="mailto:a20000.gupta@gmail.com">a20000.gupta@gmail.com</a>.</p>

      <h2>What {PRODUCT_NAME} processes</h2>
      <p>The website offers Browser mode, Local agent mode, and, where a deployment explicitly makes it available, Server mode. The information handled depends on the mode you choose:</p>
      <ul>
        <li><strong>Browser mode:</strong> Supported image, SVG, PDF editor, PDF text editor, and PDF compression work runs in your browser. The selected files and temporary results stay in browser memory and are not uploaded by Browser mode. You choose when to download a result.</li>
        <li><strong>Local agent mode:</strong> The Local agent runs supported processing on your connected macOS, Windows, or Linux desktop. Source files and generated results stay on that device; a result is retained there only when you choose to keep it.</li>
        <li><strong>Server mode:</strong> If a deployment shows Server mode as available, selected files are sent to its configured processing server for the requested job. That deployment may temporarily retain files, previews, and job records for processing, security, support, and cleanup according to its configuration.</li>
      </ul>

      <h2>Files and results</h2>
      <p>Browser-mode files are not sent to the website for processing, and browser previews/results are temporary in the active tab. Local-agent files and results remain on the connected desktop computer unless the Local agent needs a licensing or connectivity request. Server-mode files follow the configured server deployment’s processing and cleanup rules. Do not select files unless you have the right to process them.</p>

      <h2>Device and licensing information</h2>
      <p>When licensing or pairing is enabled, the service may receive a device identifier, operating system, application version, pairing state, license events, and operational audit records. This information is used to authorize the software, protect the licensing service, troubleshoot connectivity, and maintain an audit trail.</p>

      <h2>Website requests and service providers</h2>
      <p>Website requests can include normal technical information such as IP address, browser type, request time, device or browser details, and error details. Hosting, security, infrastructure, and licensing providers may process information needed to deliver the website and licensing features. Their handling is governed by their own policies and the configuration of the deployment.</p>

      <h2>Analytics and cookies</h2>
      <p>If you accept analytics, this website uses Google Analytics 4 through Google Tag Manager to understand page views and selected interactions with the public website. The analytics data categories are page category, page name and title, tool, processing mode, input type and count, selected action labels, result type, offer ID, and offer-code copy outcome. Google Analytics may also receive standard technical information such as browser/device information and timestamps. Google Analytics may use the first-party <code>_ga</code> cookie and a similar client identifier to distinguish visits. Analytics is denied by default, and we do not send files, file contents, filenames, exact file sizes, license information, or offer codes to Google Analytics. You can accept or reject analytics and change your choice at any time using Manage privacy choices; the preference is retained for six months. The first-party <code>media_toolbox_analytics_consent</code> cookie records your choice, consent-notice version, and time locally; it is not sent to Google Analytics.</p>

      <h2>AdSense</h2>
      <p>The public website currently includes Google’s AdSense publisher script for site verification, but the current app does not intentionally render an ad unit. Google notes that an AdSense publisher tag can still make requests and may use cookies or similar technical information even when an ad is not displayed. If advertising is enabled, Google and its advertising partners may use cookies, web beacons, IP addresses, identifiers, and related technical information to serve or measure ads, including ads based on a visitor’s prior visits to this or other websites, under their policies and applicable consent settings. We do not send files, file contents, filenames, exact file sizes, license information, or offer codes to Google through this integration. You can manage Google’s personalized advertising settings through <a href="https://adssettings.google.com/">Google Ads Settings</a> or use the <a href="https://optout.aboutads.info/">aboutads.info opt-out</a>.</p>
      <p>The site’s analytics consent banner controls GA4 only; it is not AdSense consent. Before serving ads in a region where Google or applicable law requires consent, the site must use Google’s Privacy &amp; messaging controls or another Google-certified consent management platform.</p>

      <h2>Retention and deletion</h2>
      <p>Browser source files, previews, and temporary results remain only in the active browser session and are released when the session or tab is cleared or closed. Retained Local-agent results remain until you remove them. Server job data and website request logs are retained according to the relevant deployment and provider cleanup rules. Licensing and audit records may be retained for the period needed to operate, secure, and support the service.</p>

      <h2>Your rights and complaints</h2>
      <p>Subject to applicable law, you may withdraw analytics consent at any time through Manage privacy choices. You may also contact <a href="mailto:a20000.gupta@gmail.com">a20000.gupta@gmail.com</a> to ask about processing of your personal data, request correction or erasure where applicable, or raise a privacy grievance. We will follow the complaint and response process applicable to the relevant service and deployment.</p>

      <h2>Your choices</h2>
      <p>You can use Browser mode when available, connect the Local agent on a supported macOS, Windows, or Linux desktop, choose whether to retain generated results, remove local history, reject or withdraw analytics consent, manage advertising preferences, and stop using the website. For questions about a specific deployment, contact its operator.</p>
    </article>
  </AppShell>;
}
