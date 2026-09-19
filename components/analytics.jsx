"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { BarChart3, Check, X } from "lucide-react";
import { getAnalyticsConsent, isAnalyticsConfigured, loadGoogleTagManager, pushAnalyticsEvent, setAnalyticsConsent } from "../lib/analytics.js";

const PRIVATE_PATHS = new Set(["/admin", "/license-admin"]);
const PAGE_METADATA = Object.freeze({
  "/": { pageType: "home", pageName: "home" },
  "/image-converter": { pageType: "tool", pageName: "image_converter" },
  "/pdf-compressor": { pageType: "tool", pageName: "pdf_compressor" },
  "/video-repair": { pageType: "tool", pageName: "video_repair" },
  "/video-compressor": { pageType: "tool", pageName: "video_compressor" },
  "/audio-extractor": { pageType: "tool", pageName: "audio_extractor" },
  "/svg-to-png": { pageType: "tool", pageName: "svg_to_png" },
  "/pdf-editor": { pageType: "tool", pageName: "pdf_editor" },
  "/pdf-text-editor": { pageType: "tool", pageName: "pdf_text_editor" },
  "/pdf-to-images": { pageType: "tool", pageName: "pdf_to_images" },
  "/offers": { pageType: "offer", pageName: "offers" },
  "/contact": { pageType: "static_page", pageName: "contact_us" },
  "/coming-soon": { pageType: "static_page", pageName: "coming_soon" },
  "/privacy": { pageType: "static_page", pageName: "privacy_policy" },
  "/terms": { pageType: "static_page", pageName: "terms" },
  "/local-agent": { pageType: "static_page", pageName: "local_agent" },
  "/how-to-setup-agent": { pageType: "static_page", pageName: "how_to_setup_agent" },
  "/browser-vs-local-agent": { pageType: "guide", pageName: "browser_vs_local_agent" },
  "/mock-api": { pageType: "tool", pageName: "mock_api" },
});

function publicPath(pathname) {
  return !PRIVATE_PATHS.has(String(pathname || "").split("?", 1)[0]);
}

function cleanPath(value) {
  const path = String(value || "/").split(/[?#]/, 1)[0];
  return path.startsWith("/") ? path : "/";
}

function getPageMetadata(pathname) {
  const pagePath = cleanPath(pathname);
  if (PAGE_METADATA[pagePath]) return PAGE_METADATA[pagePath];
  if (pagePath.startsWith("/downloads/")) return { pageType: "static_page", pageName: "downloads" };
  return { pageType: "static_page", pageName: "other_static_page" };
}

export function AnalyticsRuntime() {
  const router = useRouter();
  const [consent, setConsent] = useState("unknown");
  const [bannerOpen, setBannerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const lastPageViewRef = useRef("");
  const lastToolOpenRef = useRef("");

  useEffect(() => {
    if (!isAnalyticsConfigured() || !publicPath(router.pathname)) return undefined;
    const stored = getAnalyticsConsent();
    setConsent(stored);
    setBannerOpen(stored === "unknown");
    if (stored === "granted") loadGoogleTagManager();

    const handleConsent = (event) => {
      const value = event.detail?.value;
      if (value !== "granted" && value !== "denied") return;
      setConsent(value);
      setBannerOpen(false);
      setDetailsOpen(false);
      if (value === "granted") loadGoogleTagManager();
    };
    const openChoices = () => {
      setBannerOpen(true);
      setDetailsOpen(true);
    };
    window.addEventListener("media-toolbox-analytics-consent", handleConsent);
    window.addEventListener("media-toolbox-open-analytics-consent", openChoices);
    return () => {
      window.removeEventListener("media-toolbox-analytics-consent", handleConsent);
      window.removeEventListener("media-toolbox-open-analytics-consent", openChoices);
    };
  }, [router.pathname]);

  const trackPageView = useCallback((url) => {
    if (consent !== "granted" || !publicPath(router.pathname)) return;
    const pagePath = cleanPath(url || router.asPath);
    if (pagePath === lastPageViewRef.current) return;
    lastPageViewRef.current = pagePath;
    const pageMetadata = getPageMetadata(pagePath);
    pushAnalyticsEvent("custom_page_view", { ...pageMetadata, page_title: document.title });
    if (pageMetadata.pageType === "tool" && pageMetadata.pageName !== lastToolOpenRef.current) {
      lastToolOpenRef.current = pageMetadata.pageName;
      pushAnalyticsEvent("tool_open", { tool: pageMetadata.pageName });
    }
  }, [consent, router.asPath, router.pathname]);

  useEffect(() => {
    if (!isAnalyticsConfigured() || consent !== "granted" || !publicPath(router.pathname)) return undefined;
    loadGoogleTagManager();
    trackPageView(router.asPath);
    const handleRouteChange = (url) => trackPageView(url);
    router.events.on("routeChangeComplete", handleRouteChange);
    return () => router.events.off("routeChangeComplete", handleRouteChange);
  }, [consent, router.asPath, router.events, router.pathname, trackPageView]);

  useEffect(() => {
    if (!isAnalyticsConfigured() || consent !== "granted" || !publicPath(router.pathname)) return undefined;
    const handleClick = (event) => {
      const target = event.target?.closest?.("[data-analytics-cta]");
      if (!target) return;
      pushAnalyticsEvent("cta_click", {
        cta: target.dataset.analyticsCta,
        surface: target.dataset.analyticsSurface,
      });
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [consent, router.pathname]);

  if (!isAnalyticsConfigured() || !publicPath(router.pathname)) return null;

  const chooseConsent = (value) => setAnalyticsConsent(value);
  return <aside className={`analytics-consent-banner ${bannerOpen ? "is-open" : "is-hidden"}`} role="region" aria-hidden={!bannerOpen} aria-labelledby="analytics-consent-title" aria-describedby="analytics-consent-description">
    <div className="analytics-consent-heading"><span className="analytics-consent-icon"><BarChart3 size={17} aria-hidden="true" /></span><div><strong id="analytics-consent-title">Analytics preferences</strong><button className="analytics-consent-close" type="button" onClick={() => setBannerOpen(false)} aria-label="Close analytics preferences" title="Close"><X size={15} /></button></div></div>
    <p id="analytics-consent-description">We use Google Analytics to improve NativeMedia Agent. We don’t send your files or identifying information.</p>
    {detailsOpen && <div id="analytics-consent-details" className="analytics-consent-details"><p>After you accept, analytics may use the page category, page name and title, tool, processing mode, input type and count, selected action labels, result type, offer ID, and copy outcome. Google Analytics may also receive standard technical information such as browser/device information and timestamps. The purpose is to understand usage and improve the website. We do not send your files, file contents, filenames, exact file sizes, license information, or offer codes.</p><Link href="/privacy">Read the Privacy Policy</Link></div>}
    <div className="analytics-consent-actions"><button className="primary-button" type="button" onClick={() => chooseConsent("granted")}><Check size={15} /> Accept analytics</button><button className="secondary-button" type="button" onClick={() => chooseConsent("denied")}>Reject analytics</button><button className="analytics-consent-preferences" type="button" onClick={() => setDetailsOpen((value) => !value)}>{detailsOpen ? "Hide details" : "Privacy choices"}</button></div>
    {consent !== "unknown" && <small className="analytics-consent-current">Current choice: {consent === "granted" ? "analytics accepted" : "analytics rejected"}</small>}
  </aside>;
}
