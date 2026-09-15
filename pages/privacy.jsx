import { AppShell } from "../components/app-shell.jsx";

export default function PrivacyPolicyPage() {
  return <AppShell>
    <article className="legal-document">
      <div className="section-kicker"><span className="kicker-line" /> Privacy</div>
      <h1>Privacy Policy</h1>
      <p className="legal-intro">Media Toolbox is designed to keep everyday media work private and understandable.</p>
      <p className="legal-meta">Last updated: <time dateTime="2026-09-15">September 15, 2026</time></p>

      <h2>What Media Toolbox processes</h2>
      <p>Depending on the workflow you choose, files are processed in your browser, by the connected Media Toolbox local agent, or by the processing service configured for your deployment. The interface identifies the available processing path before a job is submitted where that distinction matters.</p>

      <h2>Files and results</h2>
      <p>Uploaded files, temporary job data, previews, and generated results are used to complete the requested operation. Local-agent results are stored on the device only when you choose to retain them. Do not upload files unless you have the right to process them.</p>

      <h2>Device and licensing information</h2>
      <p>When licensing or pairing is enabled, the service may receive a device identifier, operating system, application version, pairing state, license events, and operational audit records. This information is used to authorize the software, protect the licensing service, troubleshoot connectivity, and maintain an audit trail.</p>

      <h2>Website requests and service providers</h2>
      <p>Website requests can include normal technical information such as IP address, browser type, request time, and error details. Hosting, proxy, networking, and licensing providers may process information needed to deliver the requested service. Their handling is governed by their own policies and the configuration of the deployment.</p>

      <h2>Retention and deletion</h2>
      <p>Temporary data is deleted according to the cleanup rules of the active deployment. Retained local results remain until you remove them. Licensing and audit records may be retained for the period needed to operate, secure, and support the service.</p>

      <h2>Your choices</h2>
      <p>You can use the local agent for on-device processing when available, choose whether to retain generated results, remove local history, and stop using the service. For questions about a specific deployment, contact its operator.</p>
    </article>
  </AppShell>;
}
