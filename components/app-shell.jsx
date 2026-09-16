"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { Archive, ArrowRight, BookOpen, ChevronDown, Clock3, ExternalLink, Film, FileText, Home, Image as ImageIcon, Menu, Moon, ShieldCheck, Sparkles, Sun } from "lucide-react";
import { probeLocalAgent } from "./processing-client.js";
import { AppFooter } from "./app-footer.jsx";
import { FreeAccessModal } from "./free-access-modal.jsx";
import { metadataForPathname, normalizeSitePath, PRODUCT_TAGLINE } from "../lib/site-metadata.js";
import { formatAccessDuration } from "../lib/access-duration.js";

const navigation = [
  { href: "/", label: "Home", detail: "NativeMedia Agent overview", icon: Home },
  { href: "/image-converter", label: "Image converter", detail: "Resize-free format conversion", icon: ImageIcon },
  { href: "/svg-to-png", label: "SVG to PNG", detail: "Rasterize SVG at any scale", icon: ImageIcon, beta: true },
  { href: "/video-repair", label: "Video repair", detail: "Layered recovery workflow", icon: Film },
];

const pdfNavigation = [
  { href: "/pdf-editor", label: "PDF editor", detail: "Merge and arrange pages", icon: FileText, beta: true },
  { href: "/pdf-text-editor", label: "PDF text editor", detail: "Edit existing PDF text", icon: FileText, beta: true },
  { href: "/pdf-compressor", label: "PDF compressor", detail: "Reduce PDF file size", icon: Archive },
];

const moreNavigation = [
  { href: "/coming-soon", label: "Coming soon", detail: "More tools in progress", icon: Sparkles },
];

function breadcrumbLabelFor(pathname) {
  const normalizedPath = normalizeSitePath(pathname);
  return metadataForPathname(normalizedPath).breadcrumbLabel || metadataForPathname(normalizedPath).title.replace(/\s*\|\s*NativeMedia Agent$/, "");
}

function Breadcrumbs({ pathname }) {
  const normalizedPath = normalizeSitePath(pathname);
  const pageLabel = breadcrumbLabelFor(normalizedPath);
  return <div className="breadcrumb-wrap">
    <nav className="breadcrumb-nav" aria-label="Breadcrumb">
      {normalizedPath === "/" ? <span aria-current="page">Home</span> : <><Link href="/" title="Home">Home</Link><span className="breadcrumb-separator" aria-hidden="true">/</span><span aria-current="page">{pageLabel}</span></>}
    </nav>
  </div>;
}

function accessTimerFor(authorization, now, trialAvailable = false) {
  if (!authorization) return null;
  if (authorization.mode === "admin") return { label: "Access", value: "Unlimited", state: "admin" };

  if (authorization.mode === "trial" || authorization.mode === "activation") {
    const expiresAt = Number(authorization.expiresAt || 0);
    const remainingMs = expiresAt
      ? Math.max(0, expiresAt - now)
      : Math.max(0, Number(authorization.remainingMs || 0));
    if (!remainingMs) return { label: authorization.mode === "trial" ? "Trial" : "Access", value: "Expired", state: "expired" };

    return { label: authorization.mode === "trial" ? "Trial" : "Access", value: formatAccessDuration(remainingMs), state: authorization.mode };
  }

  if (authorization.legalAccepted && (authorization.trialAvailable || trialAvailable)) return { label: "Trial", value: "Ready", state: "available" };
  return { label: "Access", value: "Locked", state: "locked" };
}

function AgentSetupPrompt() {
  return <div className="agent-setup-banner" role="complementary" aria-label="NativeMedia Agent setup guide">
    <div className="agent-setup-banner-copy">
      <BookOpen size={23} aria-hidden="true" />
      <div>
        <strong>New to NativeMedia Agent?</strong>
        <span>Follow the platform-specific setup steps with visual guidance.</span>
      </div>
    </div>
    <Link className="secondary-button" href="/how-to-setup-agent">Open setup guide <ExternalLink size={16} aria-hidden="true" /></Link>
  </div>;
}

export function AppShell({ children }) {
  const { pathname } = useRouter();
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(false);
  const [theme, setTheme] = useState("dark");
  const [localAgentStatus, setLocalAgentStatus] = useState(null);
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const [pdfToolsOpen, setPdfToolsOpen] = useState(false);

  const pdfToolActive = pdfNavigation.some((item) => pathname === item.href);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 680px)");
    const handleViewportChange = (event) => setMobileViewport(event.matches);
    setMobileViewport(media.matches);
    media.addEventListener?.("change", handleViewportChange);
    return () => media.removeEventListener?.("change", handleViewportChange);
  }, []);

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("media-toolbox-theme");
    const nextTheme = savedTheme === "light" ? "light" : "dark";
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

  const authorization = localAgentStatus?.authorization || localAgentStatus?.health?.authorization;
  const accessTimer = accessTimerFor(authorization, timerNow, localAgentStatus?.health?.trialAvailable);
  const agentSetupAttention = Boolean(localAgentStatus && !localAgentStatus.connected);
  // The Local agent page already has its full setup card. Avoid stacking the
  // same call-to-action there and on the setup guide destination itself.
  const showAgentSetupPrompt = Boolean(localAgentStatus && !localAgentStatus.available && pathname !== "/local-agent" && pathname !== "/how-to-setup-agent");

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

  const toggleSidebar = () => {
    if (window.matchMedia("(max-width: 680px)").matches) {
      setMobileOpen((value) => !value);
      return;
    }
    setSidebarHidden((value) => !value);
  };

  const menuExpanded = mobileViewport ? mobileOpen : !sidebarHidden;
  const menuLabel = menuExpanded ? "Hide tools" : "Show tools";

  return <div className={`app-shell ${sidebarHidden ? "sidebar-hidden" : ""} ${mobileOpen ? "mobile-menu-open" : ""}`}>
    <header className="topbar">
      <button className="topbar-menu-button" type="button" aria-label={menuLabel} title={menuLabel} aria-controls="app-sidebar" aria-expanded={menuExpanded} onClick={toggleSidebar}><Menu size={21} aria-hidden="true" /></button>
      <Link href="/" className="topbar-brand" aria-label="NativeMedia Agent home">
        <div className="topbar-brand-main">
          <div className="brand-mark"><img className="brand-logo" src="/media-toolbox-logo-64.png" srcSet="/media-toolbox-logo-64.png 64w, /media-toolbox-logo-128.png 128w" sizes="(max-width: 680px) 34px, 58px" width="58" height="58" decoding="async" alt="NativeMedia Agent logo" title="NativeMedia Agent" /></div>
          <div className="brand-copy"><span>NativeMedia</span><strong>Agent</strong></div>
        </div>
        <span className="topbar-brand-subtitle">{PRODUCT_TAGLINE}</span>
      </Link>
      <div className="topbar-actions"><button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === "dark" ? "Light mode" : "Dark mode"}</span></button><Link href="/local-agent" className={`topbar-status ${localAgentStatus?.connected ? "connected" : ""} ${agentSetupAttention ? "agent-setup-cta" : ""}`} aria-label={localAgentStatus?.connected ? "Open connected local agent" : "Open local agent connection page"} title={localAgentStatus?.connected ? "Open connected local agent" : "Open local agent connection page"}><span className={`status-pulse ${localAgentStatus?.connected ? "connected" : ""}`} /><span>{localAgentStatus?.connected ? "Agent connected" : "Agent setup"}</span>{agentSetupAttention && <ArrowRight className="topbar-setup-arrow" size={16} aria-hidden="true" />}</Link>{accessTimer && <div className={`agent-access-timer ${accessTimer.state}`} title={`${accessTimer.label}: ${accessTimer.value}`} aria-label={`${accessTimer.label} ${accessTimer.value}`}><Clock3 size={15} /><span className="timer-label">{accessTimer.label}</span><strong>{accessTimer.value}</strong></div>}</div>
    </header>
    <div className="app-body">
      <div className={`mobile-scrim ${mobileOpen ? "visible" : ""}`} onClick={() => setMobileOpen(false)} />
      <aside id="app-sidebar" className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
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
          <div className="privacy-card"><ShieldCheck size={17} /><div><strong>Private by design</strong><span>Temporary data follows cleanup rules; local results are kept only when you choose.</span></div></div>
          <span className="version-label">v1.0 · Local agent</span>
        </div>
      </aside>
      <main className="main-area">
        <div className="content-wrap">{showAgentSetupPrompt && <AgentSetupPrompt />}{children}</div>
        <Breadcrumbs pathname={pathname} />
        <AppFooter />
      </main>
    </div>
    <FreeAccessModal pathname={pathname} />
  </div>;
}
