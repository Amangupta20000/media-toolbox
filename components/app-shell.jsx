"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { Film, FileText, Image as ImageIcon, Menu, Moon, PanelLeftClose, PanelLeftOpen, ShieldCheck, Sparkles, Sun } from "lucide-react";

const navigation = [
  { href: "/image-converter", label: "Image converter", detail: "Resize-free format conversion", icon: ImageIcon },
  { href: "/video-repair", label: "Video repair", detail: "Layered recovery workflow", icon: Film },
  { href: "/pdf-editor", label: "PDF editor", detail: "Merge and arrange pages", icon: FileText },
];

const comingSoonNavigation = { href: "/coming-soon", label: "Coming soon", detail: "More tools in progress", icon: Sparkles };

export function AppShell({ children }) {
  const { pathname } = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("media-toolbox-theme");
    const nextTheme = savedTheme === "dark" ? "dark" : "light";
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
  }, []);

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
    <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
      <div className="brand-lockup">
        <div className="brand-mark"><Sparkles size={18} strokeWidth={2.4} /></div>
        <div className="brand-copy"><span>Media</span><strong>Toolbox</strong></div>
        <button className="icon-button sidebar-collapse" aria-label="Collapse sidebar" onClick={() => setCollapsed((value) => !value)}>{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button>
      </div>
      <div className="sidebar-label">Workspace</div>
      <nav className="tool-nav" aria-label="Tools">
        {navigation.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href;
          return <Link key={item.href} href={item.href} className={`tool-nav-item ${active ? "active" : ""}`} onClick={() => setMobileOpen(false)} title={item.label}>
            <span className="nav-icon"><Icon size={19} /></span>
            <span className="nav-copy"><strong>{item.label}</strong><small>{item.detail}</small></span>
            {active && <span className="active-dot" />}
          </Link>;
        })}
      </nav>
      <div className="sidebar-label coming-soon-nav-label">More tools</div>
      <nav className="tool-nav" aria-label="Coming soon tools">
        <Link href={comingSoonNavigation.href} className={`tool-nav-item ${pathname === comingSoonNavigation.href ? "active" : ""}`} onClick={() => setMobileOpen(false)} title={comingSoonNavigation.label}>
          <span className="nav-icon"><Sparkles size={19} /></span>
          <span className="nav-copy"><strong>{comingSoonNavigation.label}</strong><small>{comingSoonNavigation.detail}</small></span>
          {pathname === comingSoonNavigation.href && <span className="active-dot" />}
        </Link>
      </nav>
      <div className="sidebar-footer">
        <div className="privacy-card"><ShieldCheck size={17} /><div><strong>Private by design</strong><span>Files are temporary and auto-cleaned.</span></div></div>
        <span className="version-label">v1.0 · self-hosted worker</span>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <button className="mobile-menu-button" aria-label="Open tools" onClick={() => setMobileOpen(true)}><Menu size={21} /></button>
        <div className="topbar-context"><span className="eyebrow">Workspace</span><span className="topbar-title">Secure media utilities</span></div>
        <div className="topbar-actions"><button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}<span>{theme === "dark" ? "Light mode" : "Dark mode"}</span></button><div className="topbar-status"><span className="status-pulse" /> Worker connected</div></div>
      </header>
      <div className="content-wrap">{children}</div>
    </main>
  </div>;
}
