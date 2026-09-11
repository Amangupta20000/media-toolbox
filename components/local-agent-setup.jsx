"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Laptop, LoaderCircle, RefreshCw, ShieldCheck, TerminalSquare, XCircle } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { agentBaseUrl, pairLocalAgent, probeLocalAgent } from "./processing-client.js";

const releasesUrl = process.env.NEXT_PUBLIC_AGENT_RELEASES_URL || "https://github.com/Amangupta20000/media-toolbox/releases/latest";
const macBuildSigned = process.env.NEXT_PUBLIC_MACOS_AGENT_SIGNED === "true";

export function LocalAgentSetup() {
  const [status, setStatus] = useState(null);
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState("");

  const check = useCallback(async () => {
    setError("");
    try { setStatus(await probeLocalAgent()); } catch (checkError) { setStatus({ available: false, connected: false, error: checkError instanceof Error ? checkError.message : "The local agent is not running." }); }
  }, []);

  useEffect(() => { check(); const timer = window.setInterval(check, 5000); return () => window.clearInterval(timer); }, [check]);

  const pair = async (event) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) { setError("Enter the 6-digit code shown by the Local agent."); return; }
    setPairing(true); setError("");
    try { setStatus(await pairLocalAgent(code)); setCode(""); } catch (pairError) { setError(pairError instanceof Error ? pairError.message : "Pairing failed."); } finally { setPairing(false); }
  };

  const capabilities = status?.capabilities;
  const capabilityRows = [
    ["FFmpeg", capabilities?.video?.ffmpeg],
    ["ImageMagick", capabilities?.image?.imagemagick],
    ["HEIC / libheif", capabilities?.image?.heic || capabilities?.image?.libheif],
    ["MKVToolNix", capabilities?.video?.mkvmerge],
    ["Untrunc", capabilities?.video?.untrunc],
  ];

  return <AppShell>
    <div className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> Local processing</div><h1>Local agent</h1><p>Run image, video, and PDF jobs on the same device while using the website from any browser.</p></div><div className="heading-note"><ShieldCheck size={16} /><span>Files stay on this device</span></div></div>
    <section className={`agent-status-card ${status?.connected ? "connected" : ""}`}><div className="agent-status-icon">{status?.connected ? <CheckCircle2 size={27} /> : status?.available ? <Laptop size={27} /> : <XCircle size={27} />}</div><div className="agent-status-copy"><span className="agent-status-label">{status?.connected ? "Connected" : status?.available ? "Agent found — pairing needed" : "Disconnected"}</span><strong>{status?.connected ? "Local processing is ready" : status?.available ? "Enter the one-time pairing code" : "Start the Local agent application"}</strong><small>{status?.connected ? `${status.health?.platform || "Desktop"} · ${status.health?.agentVersion || "Agent"} · ${agentBaseUrl()}` : status?.error || "The website checks 127.0.0.1:4789. The agent must be running on this device."}</small></div><button className="secondary-button" type="button" onClick={check}><RefreshCw size={16} /> Check connection</button></section>
    <section className="agent-install-card"><div className="card-heading"><div><span className="card-index">01</span><h2>Install the agent</h2></div><span className="optional-label">macOS · Windows · Linux</span></div><p className="card-description">Start here. Download the installer for the computer that should do the processing, install it, and launch the agent. It runs in the background, starts at login, and listens only on this computer.</p><div className="agent-download-grid"><a className="secondary-button" href={releasesUrl} target="_blank" rel="noreferrer"><Download size={17} /> macOS installer</a><a className="secondary-button" href={releasesUrl} target="_blank" rel="noreferrer"><Download size={17} /> Windows installer</a><a className="secondary-button" href={releasesUrl} target="_blank" rel="noreferrer"><Download size={17} /> Linux installer</a></div>{!macBuildSigned && <div className="agent-macos-note"><AlertTriangle size={17} /><span><strong>macOS first launch:</strong> This release is not Apple-notarized yet. If macOS says the app is “damaged”, copy it to Applications, then run <code>xattr -dr com.apple.quarantine "/Applications/Media Toolbox Agent.app"</code> in Terminal and open it again.</span></div>}<div className="agent-security-note"><ShieldCheck size={17} /><span>Pairing grants this website access only to jobs created by this browser. It cannot run shell commands or read arbitrary paths.</span></div></section>
    {!status?.connected && <section className="agent-pair-card"><div><div className="card-heading"><div><span className="card-index">02</span><h2>Pair this browser</h2></div><span className="optional-label">One time</span></div><p className="card-description">After installing, open the agent from the menu bar or system tray, choose “Show pairing code”, and enter the 6-digit code here.</p></div><form className="agent-pair-form" onSubmit={pair}><label htmlFor="pairing-code">Pairing code</label><div><input id="pairing-code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="123456" autoComplete="one-time-code" /><button className="primary-button" disabled={pairing}>{pairing ? <LoaderCircle className="spin" size={17} /> : <TerminalSquare size={17} />} Pair agent</button></div></form><div className="agent-open-actions"><a className="secondary-button" href="mediatoolbox://pair"><ExternalLink size={16} /> Open agent</a><span>Already installed? This opens the desktop agent.</span></div></section>}
    <section className="agent-capabilities-card"><div className="card-heading"><div><span className="card-index">03</span><h2>Available tools</h2></div><span className={status?.connected ? "optional-label" : "required-label"}>{status?.connected ? "Detected on this device" : "Waiting for agent"}</span></div><div className="agent-capabilities-grid">{capabilityRows.map(([label, available]) => <div className="agent-capability-row" key={label}><span className={`capability-dot ${available ? "ready" : ""}`} /><strong>{label}</strong><span>{available === undefined ? "Not checked" : available ? "Available" : "Unavailable"}</span></div>)}</div><p className="card-description">Optional tools are reported clearly. Image and video jobs are never moved to another machine silently.</p></section>
    {error && <div className="error-banner"><XCircle size={18} /><span>{error}</span></div>}
  </AppShell>;
}
