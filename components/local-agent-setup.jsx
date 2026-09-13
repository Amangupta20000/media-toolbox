"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Laptop, LoaderCircle, LogOut, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { DismissibleMessage } from "./dismissible-message.jsx";
import { agentBaseUrl, endAllLocalSessions, endLocalSession, getLocalSessions, localAgentToken, probeLocalAgent } from "./processing-client.js";

const releasesUrl = process.env.NEXT_PUBLIC_AGENT_RELEASES_URL || "https://github.com/Amangupta20000/media-toolbox/releases/latest";
const macBuildSigned = process.env.NEXT_PUBLIC_MACOS_AGENT_SIGNED === "true";

function authorizationLabel(authorization) {
  if (authorization?.mode === "admin") return "Admin access";
  if (authorization?.mode === "activation") return "Activated license";
  if (authorization?.mode === "trial") return "Trial active";
  return "Authorization required";
}

export function LocalAgentSetup() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionAction, setSessionAction] = useState("");
  const [sessionError, setSessionError] = useState("");
  const checkingRef = useRef(false);

  const publishStatus = useCallback((nextStatus) => {
    setStatus(nextStatus);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("media-toolbox-agent-status", { detail: nextStatus }));
  }, []);

  const loadSessions = useCallback(async () => {
    if (!localAgentToken()) { setSessions([]); return; }
    setSessionsLoading(true);
    setSessionError("");
    try {
      const value = await getLocalSessions();
      setSessions(Array.isArray(value.items) ? value.items : []);
    } catch (sessionLoadError) {
      setSessionError(sessionLoadError instanceof Error ? sessionLoadError.message : "Connected sessions could not be loaded.");
    } finally { setSessionsLoading(false); }
  }, []);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setError("");
    try {
      const nextStatus = await probeLocalAgent();
      publishStatus(nextStatus);
      if (nextStatus.connected) await loadSessions();
      else setSessions([]);
    } catch (checkError) {
      publishStatus({ available: false, connected: false, error: checkError instanceof Error ? checkError.message : "The local agent is not running." });
      setSessions([]);
    } finally { checkingRef.current = false; }
  }, [loadSessions, publishStatus]);

  useEffect(() => { check(); }, [check]);

  useEffect(() => {
    if (status === null || status?.connected) return undefined;
    const timer = window.setInterval(check, 3000);
    return () => window.clearInterval(timer);
  }, [check, status]);

  const endSession = async (sessionId) => {
    setSessionAction(sessionId); setSessionError("");
    try {
      const result = await endLocalSession(sessionId);
      if (result.current) await check(); else await loadSessions();
    } catch (sessionEndError) {
      setSessionError(sessionEndError instanceof Error ? sessionEndError.message : "The session could not be ended.");
    } finally { setSessionAction(""); }
  };

  const endAllSessions = async () => {
    if (!window.confirm("End every connected browser session for this agent?")) return;
    setSessionAction("all"); setSessionError("");
    try {
      await endAllLocalSessions();
      setSessions([]);
      await check();
    } catch (sessionEndError) {
      setSessionError(sessionEndError instanceof Error ? sessionEndError.message : "The browser sessions could not be ended.");
    } finally { setSessionAction(""); }
  };

  const capabilities = status?.capabilities;
  const agentFound = Boolean(status?.available);
  const authorization = status?.authorization || status?.health?.authorization;
  const trialAvailable = Boolean(authorization?.legalAccepted && (authorization?.trialAvailable || status?.health?.trialAvailable));
  const legalConsentRequired = Boolean(agentFound && authorization && !authorization.legalAccepted);
  const locked = Boolean(agentFound && authorization && !authorization.authorized && !trialAvailable);
  const showInstallStep = status === null || status?.available === false;
  const capabilityRows = [
    ["FFmpeg (bundled)", capabilities?.video?.ffmpeg],
    ["Bundled image engine", capabilities?.image?.sharp || capabilities?.image?.imagemagick],
    ["HEIC support (built-in)", capabilities?.image?.heic || capabilities?.image?.libheif],
    ["MKV / WebM repair (FFmpeg)", capabilities?.video?.mkvFallback || capabilities?.video?.mkvmerge],
    ["Untrunc (bundled)", capabilities?.video?.untrunc],
  ];

  return <AppShell>
    <div className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> Local processing</div><h1>Local agent</h1><p>Run image, video, and PDF jobs on the same device while using the website from any browser.</p></div><div className="heading-note"><ShieldCheck size={16} /><span>Files stay on this device</span></div></div>
    <section className={`agent-status-card ${status?.connected ? "connected" : ""}`}><div className="agent-status-icon">{status?.connected ? <CheckCircle2 size={27} /> : status?.available ? <Laptop size={27} /> : <XCircle size={27} />}</div><div className="agent-status-copy"><span className="agent-status-label">{status?.connected ? "Connected" : status?.available ? (legalConsentRequired ? "Agent found — consent required" : locked ? "Agent found — authorization needed" : trialAvailable ? "Agent found — trial available" : "Agent found") : "Disconnected"}</span><strong>{status?.connected ? "Local processing is ready" : status?.available ? (legalConsentRequired ? "Accept the Privacy Policy and Terms in the agent dashboard" : locked ? "Admin login or activation required" : trialAvailable ? "Local processing ready to start" : "Starting a browser session") : "Start the Local agent application"}</strong><small>{status?.connected ? `${status.health?.platform || "Desktop"} · ${authorizationLabel(authorization)} · ${agentBaseUrl()}` : status?.error || "The website checks 127.0.0.1:4789. The agent must be running on this device."}</small></div><button className="secondary-button" type="button" onClick={check}><RefreshCw size={16} /> Check connection</button></section>
    {showInstallStep && <section className="agent-install-card"><div className="card-heading"><div><span className="card-index">01</span><h2>Install the agent</h2></div><span className="optional-label">macOS available</span></div><p className="card-description">Download the installer for the computer that should do the processing, install it, and launch the agent. It runs in the background, starts at login, and listens only on this computer. Windows and Linux installers will be available in a future release.</p><div className="agent-download-grid"><a className="secondary-button" href={releasesUrl} target="_blank" rel="noreferrer"><Download size={17} /> macOS installer</a><button className="secondary-button agent-platform-disabled" type="button" disabled title="Windows installer coming soon" aria-label="Windows installer coming soon"><Download size={17} /> Windows installer <span>Coming soon</span></button><button className="secondary-button agent-platform-disabled" type="button" disabled title="Linux installer coming soon" aria-label="Linux installer coming soon"><Download size={17} /> Linux installer <span>Coming soon</span></button></div><div className="agent-https-note"><ShieldCheck size={17} /><span>Use the latest agent release for Safari and other secure production websites. It creates a trusted HTTPS connection to this device automatically.</span></div>{!macBuildSigned && <DismissibleMessage className="agent-macos-note" resetKey="macos-first-launch-warning"><AlertTriangle size={17} /><span><strong>macOS first launch:</strong> This release is not Apple-notarized yet. If macOS says the app is “damaged”, copy it to Applications, then run <code>xattr -dr com.apple.quarantine "/Applications/Media Toolbox Agent.app"</code> in Terminal and open it again.</span></DismissibleMessage>}<div className="agent-security-note"><ShieldCheck size={17} /><span>The website never receives Admin credentials or activation codes. Authorization is managed inside the Local agent dashboard.</span></div></section>}
    {agentFound && !status?.connected && <section className="agent-pair-card"><div className="card-heading"><div><span className="card-index">02</span><h2>{trialAvailable ? "Ready for local processing" : "Authorize this agent"}</h2></div><span className={locked ? "required-label" : "optional-label"}>{locked ? "Action required" : "Automatic"}</span></div><p className="card-description">The website only checks the agent here; it does not create a processing session or consume the five-minute trial. The session starts when you submit your first local job. For a locked agent, open the desktop dashboard to start the trial, log in as Admin, request a code, or enter an activation code.</p><div className="agent-open-actions"><a className="secondary-button" href="mediatoolbox://dashboard"><ExternalLink size={16} /> Open agent dashboard</a><span>Credentials, license requests, and activation codes stay inside the desktop application.</span></div></section>}
    <section className="agent-capabilities-card"><div className="card-heading"><div><span className="card-index">03</span><h2>Available tools</h2></div><span className={status?.connected ? "optional-label" : "required-label"}>{status?.connected ? "Detected on this device" : "Waiting for agent"}</span></div><div className="agent-capabilities-grid">{capabilityRows.map(([label, available]) => <div className="agent-capability-row" key={label}><span className={`capability-dot ${available ? "ready" : ""}`} /><strong>{label}</strong><span>{available === undefined ? "Not checked" : available ? "Available" : "Unavailable"}</span></div>)}</div><p className="card-description">FFmpeg, ffprobe, the image engine, and Untrunc are included in the installer. HEIC uses macOS sips or the bundled HEIF-capable image engine. Readable MKV/WebM files use FFmpeg; MKVToolNix remains optional for damaged-container reconstruction.</p></section>
    {status?.connected && <section className="agent-sessions-card"><div className="card-heading"><div><span className="card-index">04</span><h2>Connected browsers</h2></div><span className="optional-label">{sessions.length} active</span></div><p className="card-description">One agent can serve Chrome, Safari, other browsers, and private/incognito windows at the same time. Each browser receives its own short-lived session while the website origin is trusted.</p><div className="agent-session-list">{sessionsLoading ? <div className="agent-session-empty"><LoaderCircle className="spin" size={17} /> Loading sessions…</div> : sessions.length ? sessions.map((session) => <div className="agent-session-row" key={session.id}><div className="agent-session-copy"><strong>{session.clientLabel || "Website session"}{session.current && <span className="session-current-label">This browser</span>}</strong><small>{session.origin}</small><small>Connected {new Date(session.createdAt).toLocaleString()} · expires {new Date(session.expiresAt).toLocaleString()}</small></div><button className="secondary-button" type="button" onClick={() => endSession(session.id)} disabled={Boolean(sessionAction)}><LogOut size={16} /> {sessionAction === session.id ? "Ending…" : "End session"}</button></div>) : <div className="agent-session-empty">No active browser sessions.</div>}</div>{sessions.length > 0 && <button className="secondary-button agent-end-all" type="button" onClick={endAllSessions} disabled={Boolean(sessionAction)}><LogOut size={16} /> {sessionAction === "all" ? "Ending all sessions…" : "End all sessions"}</button>}{sessionError && <DismissibleMessage className="session-error" resetKey={sessionError}><XCircle size={16} /><span>{sessionError}</span></DismissibleMessage>}<p className="agent-session-note">Ending a session revokes its access immediately. It does not stop the desktop agent or delete local results.</p></section>}
    {error && <DismissibleMessage className="error-banner" resetKey={error}><XCircle size={18} /><span>{error}</span></DismissibleMessage>}
  </AppShell>;
}
