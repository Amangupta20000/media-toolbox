"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, CalendarClock, Check, Copy, Gift, InfinityIcon, ShieldCheck, UserRoundCheck } from "lucide-react";
import { FREE_ACCESS_CODE } from "../lib/free-access.js";
import { PRODUCT_NAME } from "../lib/site-metadata.js";
import { pushAnalyticsEvent } from "../lib/analytics.js";


const OFFER_REDEMPTION_POLICIES = Object.freeze({
  unlimited: {
    label: "Unlimited redemptions",
    description: "Redeem again for another activation any time before the offer expires.",
  },
  single: {
    label: "One redemption per person",
    description: "Each person can redeem this promotional offer once.",
  },
});

// Add future Local-agent promotions here. The redemptionPolicy controls the
// wording and makes the limit visible before someone copies a code.
const LOCAL_AGENT_OFFERS = Object.freeze([
  {
    id: "freeforall",
    code: FREE_ACCESS_CODE,
    badge: "Active launch offer",
    title: "FreeForAll",
    description: "Explore the full Local agent workflow on your own computer with a seven-day activation.",
    access: "7 days per activation",
    redemptionPolicy: "unlimited",
    statusEndpoint: "/api/license/v1/free-access",
  },
]);

function formatExpiry(timestamp) {
  if (!timestamp) return "Until the launch code expires";
  return `Until ${new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(new Date(timestamp))}`;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy is unavailable. Select the code and copy it manually.");
}

function OfferCard({ offer }) {
  const policy = OFFER_REDEMPTION_POLICIES[offer.redemptionPolicy] || OFFER_REDEMPTION_POLICIES.single;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [expiry, setExpiry] = useState(0);
  const [availability, setAvailability] = useState("checking");
  const offerViewTrackedRef = useRef(false);

  useEffect(() => {
    const trackView = () => {
      if (offerViewTrackedRef.current) return;
      if (pushAnalyticsEvent("offer_viewed", { offer_id: offer.id })) offerViewTrackedRef.current = true;
    };
    trackView();
    const handleConsent = (event) => {
      if (event.detail?.value === "granted") trackView();
    };
    window.addEventListener("media-toolbox-analytics-consent", handleConsent);
    return () => window.removeEventListener("media-toolbox-analytics-consent", handleConsent);
  }, [offer.id]);

  useEffect(() => {
    if (!offer.statusEndpoint) {
      setAvailability("active");
      return undefined;
    }
    let active = true;
    fetch(offer.statusEndpoint, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (!active) return;
        const redemptionExpiresAt = Number(payload?.redemptionExpiresAt || 0);
        setExpiry(redemptionExpiresAt);
        setAvailability(redemptionExpiresAt && redemptionExpiresAt <= Date.now() ? "expired" : "active");
      })
      .catch(() => {
        if (active) setAvailability("unknown");
      });
    return () => { active = false; };
  }, [offer.statusEndpoint]);

  const active = availability !== "expired";
  const statusLabel = availability === "expired" ? "Offer ended" : availability === "unknown" ? "Check at redemption" : availability === "checking" ? "Checking availability…" : "Available now";
  const copy = async () => {
    setCopyError("");
    try {
      await copyText(offer.code);
      setCopied(true);
      // The public site cannot verify redemption inside the desktop app. This
      // records the allowlisted code handoff without sending the code itself.
      pushAnalyticsEvent("offer_redeemed", { offer_id: offer.id, result: "code_copied" });
      window.setTimeout(() => setCopied(false), 2200);
    } catch (error) {
      setCopyError(error.message || "The code could not be copied.");
    }
  };

  return <article className={`offer-card ${active ? "active" : "expired"}`} aria-labelledby={`${offer.id}-title`}>
    <div className="offer-card-topline"><span className="offer-badge">{offer.badge}</span><span className={`offer-status ${active ? "active" : "expired"}`}><span className="offer-status-dot" />{statusLabel}</span></div>
    <div className="offer-card-heading"><span className="offer-icon"><Gift size={24} aria-hidden="true" /></span><div><h2 id={`${offer.id}-title`}>{offer.title}</h2><p>Local agent promotional access</p></div></div>
    <p className="offer-description">{offer.description}</p>
    <div className="offer-code-row"><div><span>Activation code</span><code>{offer.code}</code></div><button className="primary-button" type="button" onClick={copy} disabled={!active}>{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy code"}</button></div>
    {copyError && <p className="offer-copy-error" role="status">{copyError}</p>}
    <dl className="offer-facts">
      <div><dt>Access per activation</dt><dd>{offer.access}</dd></div>
      <div><dt>Redemption policy</dt><dd>{policy.label}</dd></div>
      <div><dt>Availability</dt><dd>{formatExpiry(expiry)}</dd></div>
    </dl>
    <p className="offer-policy-note"><ShieldCheck size={16} aria-hidden="true" />{policy.description}</p>
    <div className="offer-card-actions"><Link className="primary-button" href="/local-agent">Open Local agent setup <ArrowRight size={16} /></Link>{availability === "unknown" && <small>Offer status could not be checked right now. The licensing service confirms availability when you redeem it.</small>}</div>
  </article>;
}

export function OffersPage() {
  return <>
    <div className="page-heading offers-page-heading"><div><div className="section-kicker"><span className="kicker-line" /> Local agent offers</div><h1>Offers and activation codes</h1><p>Find current promotions for the {PRODUCT_NAME} Local agent. Every offer explains how long an activation lasts and whether its code can be redeemed unlimited times until expiry or only once per person.</p></div><div className="heading-note"><Gift size={16} /><span>{LOCAL_AGENT_OFFERS.length} offer listed</span></div></div>
    <section className="offers-intro" aria-label="How offers work"><div className="offers-intro-icon"><CalendarClock size={22} aria-hidden="true" /></div><div><h2>Built for clear promotions</h2><p>Codes are redeemed inside the Local agent workflow. Your files remain on your computer, and the offer page never asks for your files.</p></div></section>
    <section className="offers-list" aria-labelledby="current-offers-title"><div className="offers-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Current offers</div><h2 id="current-offers-title">Available Local agent access</h2></div></div>{LOCAL_AGENT_OFFERS.map((offer) => <OfferCard key={offer.id} offer={offer} />)}</section>
    <section className="offer-policy-guide" aria-labelledby="offer-policy-title"><div className="section-kicker"><span className="kicker-line" /> Redemption policies</div><h2 id="offer-policy-title">What each offer limit means</h2><div className="offer-policy-grid"><article><span><InfinityIcon size={19} aria-hidden="true" /></span><div><h3>Unlimited until expiry</h3><p>Use the code again whenever you need another activation before the launch or promotional window closes.</p></div></article><article><span><UserRoundCheck size={19} aria-hidden="true" /></span><div><h3>One redemption per person</h3><p>Use the code once for the stated promotional period. Future offers will show this restriction clearly.</p></div></article></div></section>
    <section className="offers-future" aria-label="Future offers"><div><div className="section-kicker"><span className="kicker-line" /> More to come</div><h2>New Local agent offers will appear here</h2><p>When a new code or promotion is available, this page will show its access duration, redemption limit, and expiry before you copy it.</p></div><Link className="secondary-button" href="/local-agent">Set up Local agent <ArrowRight size={16} /></Link></section>
  </>;
}
