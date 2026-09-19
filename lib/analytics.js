const GTM_ID = String(process.env.NEXT_PUBLIC_GTM_ID || "").trim();

export const ANALYTICS_CONSENT_COOKIE = "media_toolbox_analytics_consent";
export const ANALYTICS_CONSENT_MAX_AGE_SECONDS = 6 * 30 * 24 * 60 * 60;
export const ANALYTICS_CONSENT_VERSION = "v1";

const EVENT_PARAMETERS = Object.freeze({
  custom_page_view: ["page_type", "page_name", "page_title"],
  tool_open: ["tool"],
  cta_click: ["cta", "surface"],
  processing_mode_selected: ["tool", "mode"],
  input_selected: ["tool", "input_type", "count"],
  processing_started: ["tool", "mode"],
  processing_completed: ["tool", "mode", "result_type"],
  processing_failed: ["tool", "mode", "error_category"],
  result_downloaded: ["tool", "result_type"],
  offer_viewed: ["offer_id"],
  offer_redeemed: ["offer_id", "result"],
  mock_api_project_created: ["surface", "mode"],
  mock_api_collection_changed: ["surface", "mode"],
  mock_api_request_simulated: ["surface", "mode", "method"],
  mock_api_local_saved: ["surface", "mode"],
  mock_api_local_host_started: ["surface", "mode"],
  mock_api_project_deleted: ["surface", "mode"],
});

const VALUE_LIMIT = 80;

function isBrowser() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function getDataLayer() {
  if (!isBrowser()) return null;
  window.dataLayer = window.dataLayer || [];
  return window.dataLayer;
}

function gtagPush(...args) {
  const dataLayer = getDataLayer();
  if (!dataLayer) return;
  window.gtag = window.gtag || function gtag() { dataLayer.push(arguments); };
  window.gtag(...args);
}

function consentStatePayload(value) {
  return {
    analytics_storage: value === "granted" ? "granted" : "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  };
}

export function isAnalyticsConfigured() {
  return /^GTM-[A-Z0-9]+$/i.test(GTM_ID);
}

export function getAnalyticsGtmId() {
  return GTM_ID;
}

export function getAnalyticsConsent() {
  if (!isBrowser()) return "unknown";
  const entry = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${ANALYTICS_CONSENT_COOKIE}=`));
  const value = entry?.slice(`${ANALYTICS_CONSENT_COOKIE}=`.length);
  if (!value) return "unknown";
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "unknown";
  }
  const [version, state, recordedAt] = decoded.split("|");
  if (version !== ANALYTICS_CONSENT_VERSION || (state !== "granted" && state !== "denied") || !recordedAt || Number.isNaN(Date.parse(recordedAt))) {
    return "unknown";
  }
  return state;
}

function writeConsentCookie(value) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  const record = encodeURIComponent(`${ANALYTICS_CONSENT_VERSION}|${value}|${new Date().toISOString()}`);
  document.cookie = `${ANALYTICS_CONSENT_COOKIE}=${record}; Max-Age=${ANALYTICS_CONSENT_MAX_AGE_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

function removeAnalyticsCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.trim().split("=", 1)[0];
    if (!name.startsWith("_ga")) continue;
    document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
}

export function setAnalyticsConsent(value) {
  if (!isBrowser() || (value !== "granted" && value !== "denied")) return false;
  writeConsentCookie(value);
  const payload = consentStatePayload(value);
  // Set a denied default before any tag is loaded. Basic mode only loads the
  // GTM container after an explicit grant, so no pre-consent Google request is
  // possible. The update is still queued for GTM's Consent Initialization.
  gtagPush("consent", "default", { ...consentStatePayload("denied"), wait_for_update: 500 });
  gtagPush("consent", "update", payload);
  getDataLayer()?.push({ event: "media_toolbox_consent_update", ...payload });
  if (value === "denied") removeAnalyticsCookies();
  window.dispatchEvent(new CustomEvent("media-toolbox-analytics-consent", { detail: { value } }));
  return true;
}

export function loadGoogleTagManager() {
  if (!isBrowser() || !isAnalyticsConfigured() || getAnalyticsConsent() !== "granted") return false;
  if (window.__mediaToolboxGtmLoaded) return true;
  const dataLayer = getDataLayer();
  if (!dataLayer) return false;
  gtagPush("consent", "default", { ...consentStatePayload("denied"), wait_for_update: 500 });
  gtagPush("consent", "update", consentStatePayload("granted"));
  dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
  const script = document.createElement("script");
  script.async = true;
  script.id = "media-toolbox-gtm-script";
  script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(GTM_ID)}`;
  document.head.appendChild(script);
  window.__mediaToolboxGtmLoaded = true;
  return true;
}

function sanitizeParameter(key, value) {
  if (key === "count") {
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, Math.min(100, Math.round(count))) : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, VALUE_LIMIT);
  if (!normalized) return null;
  return normalized;
}

export function pushAnalyticsEvent(name, parameters = {}) {
  if (!isBrowser() || !isAnalyticsConfigured() || getAnalyticsConsent() !== "granted") return false;
  const keys = EVENT_PARAMETERS[name];
  if (!keys) return false;
  const dataLayer = getDataLayer();
  if (!dataLayer) return false;
  const safeParameters = Object.fromEntries(keys.map((key) => [key, sanitizeParameter(key, parameters[key])]).filter(([, value]) => value !== null));
  dataLayer.push({ event: name, ...safeParameters });
  return true;
}

export const ANALYTICS_EVENT_PARAMETERS = EVENT_PARAMETERS;
