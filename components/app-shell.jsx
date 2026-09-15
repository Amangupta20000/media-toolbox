"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { Archive, Bot, ChevronDown, Clock3, Film, FileText, Image as ImageIcon, Menu, Moon, ShieldCheck, Sparkles, Sun } from "lucide-react";
import { probeLocalAgent } from "./processing-client.js";
import { AppFooter } from "./app-footer.jsx";

const navigation = [
  { href: "/image-converter", label: "Image converter", detail: "Resize-free format conversion", icon: ImageIcon },
  { href: "/video-repair", label: "Video repair", detail: "Layered recovery workflow", icon: Film },
  { href: "/local-agent", label: "Local agent", detail: "Process files on this device", icon: Bot },
];

const pdfNavigation = [
  { href: "/pdf-editor", label: "PDF editor", detail: "Merge and arrange pages", icon: FileText, beta: true },
  { href: "/pdf-text-editor", label: "PDF text editor", detail: "Edit existing PDF text", icon: FileText, beta: true },
  { href: "/pdf-compressor", label: "PDF compressor", detail: "Reduce PDF file size", icon: Archive, beta: true },
];

const moreNavigation = [
  { href: "/coming-soon", label: "Coming soon", detail: "More tools in progress", icon: Sparkles },
];

function accessTimerFor(authorization, now, trialAvailable = false) {
  if (!authorization) return null;
  if (authorization.mode === "admin") return { label: "Access", value: "Unlimited", state: "admin" };

  if (authorization.mode === "trial" || authorization.mode === "activation") {
    const expiresAt = Number(authorization.expiresAt || 0);
    const remainingMs = expiresAt
      ? Math.max(0, expiresAt - now)
      : Math.max(0, Number(authorization.remainingMs || 0));
    if (!remainingMs) return { label: authorization.mode === "trial" ? "Trial" : "Access", value: "Expired", state: "expired" };

    const totalSeconds = Math.ceil(remainingMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return { label: authorization.mode === "trial" ? "Trial" : "Access", value: `${minutes}:${seconds}`, state: authorization.mode };
  }

  if (authorization.legalAccepted && (authorization.trialAvailable || trialAvailable)) return { label: "Trial", value: "Ready", state: "available" };
  return { label: "Access", value: "Locked", state: "locked" };
}

export function AppShell({ children }) {
  const { pathname } = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState("light");
  const [localAgentStatus, setLocalAgentStatus] = useState({ available: false, connected: false });
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const [pdfToolsOpen, setPdfToolsOpen] = useState(false);

  const pdfToolActive = pdfNavigation.some((item) => pathname === item.href);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("media-toolbox-theme");
    const nextTheme = savedTheme === "dark" ? "dark" : "light";
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, []);

  useEffect(() => {
    let active = true;
    const handleAgentStatus = (event) => {
      if (active) setLocalAgentStatus(event.detail || { available: false, connected: false });
    };
    window.addEventListener("media-toolbox-agent-status", handleAgentStatus);

    const check = () => probeLocalAgent().then((value) => { if (active) setLocalAgentStatus(value); }).catch(() => { if (active) setLocalAgentStatus({ available: false, connected: false }); });
    check();

    // The local-agent page owns its pairing checks. This shell only does one
    // status probe when a page is opened; repeated health polling is unnecessary.
    return () => {
      active = false;
      window.removeEventListener("media-toolbox-agent-status", handleAgentStatus);
    };
  }, [pathname]);

  const authorization = localAgentStatus.authorization || localAgentStatus.health?.authorization;
  const accessTimer = accessTimerFor(authorization, timerNow, localAgentStatus.health?.trialAvailable);

  useEffect(() => {
    if (!authorization?.expiresAt) return undefined;
    const timer = window.setInterval(() => setTimerNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [authorization?.expiresAt]);

  const toggleTheme = () => {
    setTheme((currentTheme) => {
      const nextTheme = currentTheme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = nextTheme;
      window.localStorage.setItem("media-toolbox-theme", nextTheme);
      return nextTheme;
    });
  };

  return <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
    <div className={`mobile-scrim ${mobileOpen ? "visible" : ""}`} onClick={() => setMobileOpen(false)} />
    <aside id="app-sidebar" className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
      <div className="brand-lockup">
        <div className="brand-mark"><Sparkles size={18} strokeWidth={2.4} /></div>
        <div className="brand-copy"><span>Media</span><strong>Toolbox</strong></div>
        <button
          type="button"
          className="icon-button sidebar-collapse"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          aria-controls="app-sidebar"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Menu size={18} strokeWidth={2.25} aria-hidden="true" />
        </button>
      </div>
      <div className="sidebar-context">Secure media utilities</div>
      <nav className="tool-nav" aria-label="Tools">
        {navigation.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;
          return <Link key={item.href} href={item.href} className={`tool-nav-item ${active ? "active" : ""}`} onClick={() => setMobileOpen(false)} title={item.label}>
            <span className="nav-icon"><Icon size={19} /></span>
            <span className="nav-copy"><span className="nav-label-row"><strong>{item.label}</strong>{item.beta && <span className="nav-beta">Beta</span>}</span><small>{item.detail}</small></span>
            {active && <span className="active-dot" />}
          </Link>;
        })}
        <div className="pdf-tools-group">
          <button type="button" className={`tool-nav-item pdf-tools-trigger ${pdfToolActive ? "active" : ""}`} aria-expanded={pdfToolsOpen} aria-haspopup="true" aria-controls="pdf-tools-subnav" onClick={() => setPdfToolsOpen((value) => !value)} title="PDF tools">
            <span className="nav-icon"><FileText size={19} /></span>
            <span className="nav-copy"><span className="nav-label-row"><strong>PDF tools</strong></span><small>Edit, manage, and compress PDFs</small></span>
            <ChevronDown className="pdf-tools-chevron" size={18} aria-hidden="true" />
          </button>
          {pdfToolsOpen && <div id="pdf-tools-subnav" className="pdf-tools-subnav" role="group" aria-label="PDF tools">
            {pdfNavigation.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return <Link key={item.href} href={item.href} className={`tool-nav-item pdf-tool-child ${active ? "active" : ""}`} onClick={() => setMobileOpen(false)} title={item.label}>
                <span className="nav-icon"><Icon size={17} /></span>
                <span className="nav-copy"><span className="nav-label-row"><strong>{item.label}</strong>{item.beta && <span className="nav-beta">Beta</span>}</span><small>{item.detail}</small></span>
                {active && <span className="active-dot" />}
              </Link>;
            })}
          </div>}
        </div>
      </nav>
      <div className="sidebar-label coming-soon-nav-label">More tools</div>
      <nav className="tool-nav" aria-label="More tools">
        {moreNavigation.map((item) => { const Icon = item.icon; const active = pathname === item.href; return <Link key={item.href} href={item.href} className={`tool-nav-item ${active ? "active" : ""}`} onClick={() => setMobileOpen(false)} title={item.label}><span className="nav-icon"><Icon size={19} /></span><span className="nav-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>{active && <span className="active-dot" />}</Link>; })}
      </nav>
      <div className="sidebar-footer">
        <div className="privacy-card"><ShieldCheck size={17} /><div><strong>Private by design</strong><span>Files are temporary and auto-cleaned.</span></div></div>
        <span className="version-label">v1.0 · self-hosted worker</span>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <button className="mobile-menu-button" aria-label="Open tools" onClick={() => setMobileOpen(true)}><Menu size={21} /></button>
        <div className="topbar-context"><span className="topbar-title">Workspace</span></div>
        <div className="topbar-actions"><button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === "dark" ? "Light mode" : "Dark mode"}</span></button><Link href="/local-agent" className={`topbar-status ${localAgentStatus.connected ? "connected" : ""}`} aria-label={localAgentStatus.connected ? "Open connected local agent" : "Open local agent setup"}><span className={`status-pulse ${localAgentStatus.connected ? "connected" : ""}`} /><span>{localAgentStatus.connected ? "Agent connected" : "Agent setup"}</span></Link>{accessTimer && <div className={`agent-access-timer ${accessTimer.state}`} title={`${accessTimer.label}: ${accessTimer.value}`} aria-label={`${accessTimer.label} ${accessTimer.value}`}><Clock3 size={15} /><span className="timer-label">{accessTimer.label}</span><strong>{accessTimer.value}</strong></div>}</div>
      </header>
      <div className="content-wrap">{children}</div>
      <AppFooter />
    </main>
  </div>;
}
