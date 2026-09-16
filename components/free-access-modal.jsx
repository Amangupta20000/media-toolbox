"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy, Gift, X } from "lucide-react";
import { FREE_ACCESS_CODE } from "../lib/free-access.js";
import { PRODUCT_NAME } from "../lib/site-metadata.js";

const SESSION_COOKIE = "media_toolbox_free_access_seen";
const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 60;

function hasSessionCookie() {
  return document.cookie.split(";").some((part) => part.trim().startsWith(`${SESSION_COOKIE}=`));
}

function markSessionCookie() {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SESSION_COOKIE}=1; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
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

export function FreeAccessModal({ pathname }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [codeExpiryLabel, setCodeExpiryLabel] = useState("");

  useEffect(() => {
    if (["/admin", "/license-admin", "/offers"].includes(pathname) || hasSessionCookie()) return undefined;
    const showOnScroll = () => {
      if (window.scrollY <= 0) return;
      markSessionCookie();
      setVisible(true);
      window.removeEventListener("scroll", showOnScroll);
      fetch("/api/license/v1/free-access", { cache: "no-store" })
        .then((response) => response.ok ? response.json() : null)
        .then((payload) => {
          const expiry = Number(payload?.redemptionExpiresAt || 0);
          if (expiry > Date.now()) setCodeExpiryLabel(new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(new Date(expiry)));
        })
        .catch(() => { /* The modal still explains the launch window if the status endpoint is unavailable. */ });
    };
    window.addEventListener("scroll", showOnScroll, { passive: true });
    return () => window.removeEventListener("scroll", showOnScroll);
  }, [pathname]);

  useEffect(() => {
    if (!visible) return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape") setVisible(false); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [visible]);

  if (!visible) return null;

  const close = () => setVisible(false);
  const copy = async () => {
    setCopyError("");
    try {
      await copyText(FREE_ACCESS_CODE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch (error) {
      setCopyError(error.message || "The code could not be copied.");
    }
  };

  const expiryText = codeExpiryLabel || "the launch code expires";
  return <div className="free-access-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="free-access-dialog" role="dialog" aria-modal="true" aria-labelledby="free-access-title" aria-describedby="free-access-description">
      <button className="free-access-close" type="button" aria-label="Close launch offer" title="Close" onClick={close}><X size={18} /></button>
      <div className="free-access-icon"><Gift size={23} /></div>
      <span className="free-access-kicker">A launch thank-you <span className="free-access-celebration" aria-hidden="true">🎉</span></span>
      <h2 id="free-access-title">Try {PRODUCT_NAME} free until {expiryText}</h2>
      <p id="free-access-description">New here? Use our launch code to explore the toolbox on your desktop. No account is needed, and the Local agent keeps your files on your own computer.</p>
      <div className="free-access-code-row"><code>{FREE_ACCESS_CODE}</code><button className="primary-button" type="button" onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy code"}</button></div>
      <p className="free-access-note">Each activation gives 7 days. You can redeem the code unlimited times until {expiryText}.</p>
      {copyError && <p className="free-access-copy-error" role="status">{copyError}</p>}
      <div className="free-access-actions"><Link className="text-link" href="/local-agent" onClick={close}>Open Local agent setup</Link><button className="secondary-button" type="button" onClick={close}>Maybe later</button></div>
    </section>
  </div>;
}
