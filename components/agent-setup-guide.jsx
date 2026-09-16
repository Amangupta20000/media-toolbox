"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, BookOpen, CheckCircle2, Download, FolderOpen, Globe2, Laptop, Monitor, MousePointerClick, RefreshCw, Settings2, ShieldCheck, Terminal } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { ToolFaqContent } from "./tool-seo-content.jsx";
import { AGENT_DOWNLOAD_PATHS } from "../lib/agent-downloads.js";

const releasesUrl = process.env.NEXT_PUBLIC_AGENT_RELEASES_URL || "https://github.com/Amangupta20000/media-toolbox/releases/latest";

const platforms = [
  {
    id: "macos",
    label: "macOS",
    Icon: Laptop,
    summary: "Install the DMG, move the app to Applications, then allow the first launch if macOS asks.",
    steps: [
      ["Download the macOS installer", "Use the direct download link below to get the latest macOS .dmg asset for your Mac.", "Download the latest .dmg"],
      ["Move it to Applications", "Open the DMG and drag NativeMedia Agent into Applications. If an older copy is there, choose Replace before launching the new copy."],
      ["Allow the first launch", "Open NativeMedia Agent from Applications. If macOS says it cannot verify the app, open System Settings → Privacy & Security → Open Anyway, then confirm Open."],
      ["Connect the website", "Keep the agent running, return to this website, open Local agent, and choose Check connection. Complete any authorization inside the desktop app."],
    ],
    note: "For a clean upgrade, quit the old NativeMedia Agent from the menu bar before replacing it from a DMG.",
  },
  {
    id: "windows",
    label: "Windows",
    Icon: Monitor,
    summary: "Run the Windows installer, launch the app from the Start menu, and connect it from the Local agent page.",
    steps: [
      ["Download the Windows installer", "Use the direct download link below to get the latest Windows .exe installer.", "Download the latest .exe"],
      ["Install the app", "Run the installer and follow the prompts. Keep the default installation location unless you have a reason to change it."],
      ["Launch NativeMedia Agent", "Open the app from the Start menu and leave it running while you use the website. It works in the background and listens only on this computer."],
      ["Connect the website", "Return to this website, open Local agent, and choose Check connection. Complete any authorization inside the desktop app before starting a job."],
    ],
    note: "If Windows shows a security prompt, verify that you downloaded the installer from the official NativeMedia Agent release before continuing.",
  },
  {
    id: "linux",
    label: "Linux",
    Icon: Terminal,
    summary: "Choose the AppImage or Debian package that matches your system, start the agent, and connect the browser.",
    steps: [
      ["Download a Linux package", "Use the direct download link below to get the latest Linux AppImage. The release page also contains the .deb package.", "Download the latest Linux build"],
      ["Install or make it executable", "Install the .deb with your normal package installer. For an AppImage, make it executable and launch it from your file manager or terminal.", "chmod +x NativeMedia-Agent-*.AppImage"],
      ["Start the agent", "Open NativeMedia Agent and leave it running while you use the website. The agent keeps processing on this computer."],
      ["Connect the website", "Return to this website, open Local agent, and choose Check connection. Complete any authorization inside the desktop app before starting a job."],
    ],
    note: "Use the package format supported by your distribution. Keep the release asset and its source verified before installing.",
  },
];

function SetupFlowDiagram({ platformId = "overview", platformLabel = "your desktop" }) {
  const arrowId = `agent-guide-arrow-${platformId}`;
  const titleId = `agent-guide-diagram-title-${platformId}`;
  return <figure className="agent-guide-diagram">
    <div className="agent-guide-diagram-heading"><span>How the pieces connect</span><small>{platformLabel} setup flow</small></div>
    <svg viewBox="0 0 760 220" role="img" aria-labelledby={titleId}>
      <title id={titleId}>Browser interface connects to the desktop Local agent and then to local tools and results</title>
      <defs>
        <linearGradient id={`agent-guide-route-${platformId}`} x1="0" x2="1">
          <stop offset="0" stopColor="#39b9ba" />
          <stop offset="1" stopColor="#8fe0d8" />
        </linearGradient>
        <marker id={arrowId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" fill="#55bfc0" />
        </marker>
      </defs>
      <path className="agent-guide-route" d="M145 104 H615" stroke={`url(#agent-guide-route-${platformId})`} markerEnd={`url(#${arrowId})`} />
      <circle className="agent-guide-flow-dot" cx="145" cy="104" r="6" />
      <g className="agent-guide-svg-node">
        <rect x="18" y="55" width="127" height="98" rx="16" />
        <circle cx="81" cy="84" r="15" />
        <path d="M75 84h12M81 78v12" />
        <text x="81" y="119">Browser</text>
        <text x="81" y="136">interface</text>
      </g>
      <g className="agent-guide-svg-node emphasized">
        <rect x="211" y="38" width="160" height="132" rx="18" />
        <circle cx="291" cy="76" r="15" />
        <path d="M284 76h14M291 69v14" />
        <text x="291" y="117">Local agent</text>
        <text x="291" y="136">on {platformLabel}</text>
        <text x="291" y="153">private processing</text>
      </g>
      <g className="agent-guide-svg-node">
        <rect x="438" y="55" width="127" height="98" rx="16" />
        <circle cx="501" cy="84" r="15" />
        <path d="M494 84h14M501 77v14" />
        <text x="501" y="119">Native tools</text>
        <text x="501" y="136">FFmpeg · PDF · images</text>
      </g>
      <g className="agent-guide-svg-node">
        <rect x="615" y="55" width="127" height="98" rx="16" />
        <circle cx="678" cy="84" r="15" />
        <path d="M670 84l6 6 11-13" />
        <text x="678" y="119">New result</text>
        <text x="678" y="136">ready to download</text>
      </g>
    </svg>
    <figcaption>Files move from the browser interface to the agent on the same computer, where the selected native tool creates a new result.</figcaption>
  </figure>;
}

function InstallStepsDiagram({ platformId = "macos", platformLabel = "your desktop" }) {
  const titleId = `agent-guide-install-title-${platformId}`;
  const copyByPlatform = {
    macos: {
      download: "Download .dmg",
      file: "NativeMedia Agent.app",
      install: "Move to Applications",
      installDetail: "Drag & replace",
      permission: "Allow first launch",
      permissionDetail: "Open Anyway",
      connect: "Connect website",
    },
    windows: {
      download: "Download .exe",
      file: "NativeMedia Agent",
      install: "Install the app",
      installDetail: "Follow prompts",
      permission: "Launch the agent",
      permissionDetail: "Keep it running",
      connect: "Connect website",
    },
    linux: {
      download: "Download package",
      file: "NativeMedia Agent",
      install: "Install or run",
      installDetail: "AppImage or .deb",
      permission: "Start the agent",
      permissionDetail: "Leave it running",
      connect: "Connect website",
    },
  };
  const copy = copyByPlatform[platformId] || copyByPlatform.macos;
  const title = `${platformLabel} installation: ${copy.download}, ${copy.install}, ${copy.permission}, ${copy.connect}`;
  return <figure className="agent-guide-diagram agent-install-diagram">
    <div className="agent-guide-diagram-heading"><span>Installation walkthrough</span><small>watch the four steps</small></div>
    <div className="agent-install-video" role="img" aria-labelledby={titleId}>
      <span className="sr-only" id={titleId}>{title}</span>
      <div className="agent-install-video-stage">
        <div className="agent-install-frame" style={{ animationDelay: "0s" }}>
          <div className="agent-install-frame-kicker">01 · {copy.download}</div>
          <div className="agent-install-window agent-install-download-window">
            <div className="agent-install-window-bar"><span /><span /><span /><small>NativeMedia Agent installer</small></div>
            <div className="agent-install-dialog-body"><Download size={25} /><strong>Ready to install</strong><small>NativeMedia Agent on {platformLabel}</small><button className="agent-install-demo-button" type="button">Install</button><MousePointerClick className="agent-install-cursor" size={24} aria-hidden="true" /></div>
          </div>
        </div>
        <div className="agent-install-frame" style={{ animationDelay: "4s" }}>
          <div className="agent-install-frame-kicker">02 · {copy.install}</div>
          <div className="agent-install-window agent-install-drag-window">
            <div className="agent-install-window-bar"><span /><span /><span /><small>Move the app into place</small></div>
            <div className="agent-install-drag-stage"><div className="agent-install-file-card"><FolderOpen size={22} /><strong>{copy.file}</strong><small>from the installer</small></div><ArrowRight className="agent-install-drag-arrow" size={25} /><div className="agent-install-folder-card"><FolderOpen size={25} /><strong>{platformId === "macos" ? "Applications" : "Install location"}</strong><small>{copy.installDetail}</small></div><div className="agent-install-drag-ghost"><FolderOpen size={18} /> {copy.file}</div></div>
            <div className="agent-install-window-hint">{platformId === "macos" ? "Drag the app to Applications · Replace the old copy if asked" : copy.installDetail}</div>
          </div>
        </div>
        <div className="agent-install-frame" style={{ animationDelay: "8s" }}>
          <div className="agent-install-frame-kicker">03 · {copy.permission}</div>
          <div className="agent-install-window agent-install-settings-window">
            <div className="agent-install-window-bar"><span /><span /><span /><small>System Settings</small></div>
            <div className="agent-install-settings-layout"><div className="agent-install-settings-side"><Settings2 size={18} /><strong>{platformId === "macos" ? "Privacy & Security" : "Security"}</strong></div><div className="agent-install-settings-main"><strong>{platformId === "macos" ? "NativeMedia Agent" : copy.file}</strong><small>{platformId === "macos" ? "This app was blocked from opening" : "Allow the app to run"}</small><button className="agent-install-demo-button" type="button">{platformId === "macos" ? "Open Anyway" : "Allow"}</button></div></div>
            {platformId === "macos" && <div className="agent-install-confirm"><strong>Open NativeMedia Agent?</strong><button type="button">Open</button></div>}
          </div>
        </div>
        <div className="agent-install-frame" style={{ animationDelay: "12s" }}>
          <div className="agent-install-frame-kicker">04 · {copy.connect}</div>
          <div className="agent-install-window agent-install-connect-window">
            <div className="agent-install-browser-bar"><Globe2 size={16} /><span>native-media-agent.vercel.app/local-agent</span></div>
            <div className="agent-install-connect-body"><div className="agent-install-connect-heading"><span className="agent-install-online-dot" /><div><strong>Local agent</strong><small>Ready to connect</small></div></div><button className="agent-install-demo-button" type="button">Check connection <ArrowRight size={15} /></button><div className="agent-install-connected"><CheckCircle2 size={16} /> Agent connected</div></div>
          </div>
        </div>
      </div>
      <div className="agent-install-video-progress" aria-hidden="true"><span style={{ animationDelay: "0s" }}>01</span><span style={{ animationDelay: "4s" }}>02</span><span style={{ animationDelay: "8s" }}>03</span><span style={{ animationDelay: "12s" }}>04</span></div>
    </div>
    <figcaption>{platformId === "macos" ? "Watch the full macOS flow: click Install, move the app to Applications, allow the first launch, then connect the website." : `Watch the ${platformLabel} flow: install the app, start the agent, then connect the website.`}</figcaption>
  </figure>;
}

function PlatformPanel({ platform, active }) {
  const { Icon } = platform;
  return <section className="agent-guide-tabpanel" id={`agent-guide-panel-${platform.id}`} role="tabpanel" aria-labelledby={`agent-guide-tab-${platform.id}`} hidden={!active}>
    <div className="agent-guide-panel-heading">
      <div><span className="section-kicker"><span className="kicker-line" /> {platform.label} setup</span><h2>Set up NativeMedia Agent on {platform.label}</h2><p>{platform.summary}</p></div>
      <Icon className="agent-guide-panel-icon" size={34} aria-hidden="true" />
    </div>
    <div className="agent-guide-panel-grid">
      <ol className="agent-guide-steps">
        {platform.steps.map(([title, body, action], index) => <li key={title}>
          <span className="agent-guide-step-number">{String(index + 1).padStart(2, "0")}</span>
          <div><h3>{title}</h3><p>{body}</p>{action && <a className="agent-guide-inline-action" href={AGENT_DOWNLOAD_PATHS[platform.id]}><Download size={14} /> {action}</a>}</div>
        </li>)}
      </ol>
      <div className="agent-guide-visual-column"><InstallStepsDiagram platformId={platform.id} platformLabel={platform.label} /><div className="agent-guide-note"><ShieldCheck size={16} /><span>{platform.note}</span></div></div>
    </div>
  </section>;
}

export function AgentSetupGuide() {
  const [activePlatform, setActivePlatform] = useState("macos");

  return <AppShell>
    <section className="agent-guide-hero">
      <div className="agent-guide-hero-copy"><div className="section-kicker"><span className="kicker-line" /> Desktop setup guide</div><h1>How to set up the Local agent</h1><p>Install NativeMedia Agent on your computer, connect it to this browser, and keep supported media processing on your desktop.</p><div className="agent-guide-hero-actions"><Link className="primary-button" href="/local-agent"><CheckCircle2 size={17} /> Open Local agent</Link><a className="secondary-button" href={releasesUrl} target="_blank" rel="noreferrer"><Download size={17} /> Latest release</a></div></div>
      <SetupFlowDiagram />
    </section>

    <section className="agent-guide-platforms" aria-labelledby="agent-guide-platform-title">
      <div className="agent-guide-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Choose your computer</div><h2 id="agent-guide-platform-title">Install in four simple steps</h2><p>Pick your operating system. The website stays your interface; the Local agent does the work on your computer.</p></div><BookOpen size={30} aria-hidden="true" /></div>
      <div className="agent-guide-tabs" role="tablist" aria-label="Operating system setup guides">{platforms.map(({ id, label, Icon }) => <button key={id} id={`agent-guide-tab-${id}`} type="button" role="tab" aria-selected={activePlatform === id} aria-controls={`agent-guide-panel-${id}`} className={activePlatform === id ? "active" : ""} onClick={() => setActivePlatform(id)}><Icon size={17} aria-hidden="true" /> {label}</button>)}</div>
      {platforms.map((platform) => <PlatformPanel key={platform.id} platform={platform} active={activePlatform === platform.id} />)}
    </section>

    <section className="agent-guide-aftercare" aria-labelledby="agent-guide-aftercare-title"><div className="agent-guide-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Once it is installed</div><h2 id="agent-guide-aftercare-title">Connect, authorize, and test</h2></div><RefreshCw size={28} aria-hidden="true" /></div><div className="agent-guide-aftercare-grid"><article><span>01</span><h3>Keep the agent open</h3><p>Leave NativeMedia Agent running while you use the website. It listens only on this computer.</p></article><article><span>02</span><h3>Check the connection</h3><p>Open the <Link href="/local-agent">Local agent page</Link> and choose Check connection. Authorization stays inside the desktop app.</p></article><article><span>03</span><h3>Run a small test</h3><p>Start with a small image or PDF so you can confirm the connection before processing a large file.</p></article></div></section>

    <section className="agent-guide-help" aria-labelledby="agent-guide-help-title"><div><div className="section-kicker"><span className="kicker-line" /> Need a hand?</div><h2 id="agent-guide-help-title">Still not connected?</h2><p>Open the Local agent page to see the exact connection status and the next action for this computer.</p></div><Link className="secondary-button" href="/local-agent">Open connection status <ArrowRight size={16} /></Link></section>
    <ToolFaqContent pathname="/how-to-setup-agent" />
  </AppShell>;
}
