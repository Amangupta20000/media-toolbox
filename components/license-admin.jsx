"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, Check, Github, LoaderCircle, LogIn, LogOut, RefreshCw, ShieldAlert, X } from "lucide-react";
import { AppShell } from "./app-shell.jsx";
import { DismissibleMessage } from "./dismissible-message.jsx";
import { approveLicenseRequest, declineLicenseRequest, getAdminAuditLog, getAdminLicenseRequests, licenseServerUrl, loginLicenseAdmin, logoutLicenseAdmin, storedAdminToken, updateGithubAgentLicenseServerUrl } from "./license-client.js";

function date(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

function duration(value) {
  const durations = { 600000: "10 minutes", 1800000: "30 minutes", 7200000: "2 hours", 21600000: "6 hours", 86400000: "1 day" };
  return durations[Number(value)] || "Unsupported duration";
}

const auditLabels = {
  "request.created": "Activation requested",
  "request.approved": "Request approved",
  "request.declined": "Request declined",
  "request.expired": "Request expired",
  "license.redeemed": "License redeemed",
  "license.expired": "Code expired",
  "device.activity": "Device activity",
  "admin.login": "Admin login",
  "admin.login.failed": "Failed admin login",
  "admin.logout": "Admin logout",
  "admin.session.expired": "Admin session expired",
};

function auditDetailText(item) {
  const details = item.details || {};
  return Object.entries(details)
    .filter(([key, value]) => value !== null && value !== undefined && value !== "" && key !== "userAgent")
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(" · ");
}

export function LicenseAdmin() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [username, setUsername] = useState("Admin");
  const [password, setPassword] = useState("");
  const [items, setItems] = useState([]);
  const [auditItems, setAuditItems] = useState([]);
  const [auditStoragePath, setAuditStoragePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [releaseServerUrl, setReleaseServerUrl] = useState("");

  const refresh = useCallback(async () => {
    if (!storedAdminToken()) return;
    try {
      const [requests, audit] = await Promise.all([getAdminLicenseRequests(), getAdminAuditLog()]);
      setItems(requests.items || []);
      setAuditItems(audit.items || []);
      setAuditStoragePath(audit.storagePath || "");
      setLoggedIn(true);
      setError("");
    } catch (refreshError) {
      setError(refreshError.message || "The licensing requests could not be loaded.");
      if (refreshError.status === 401) setLoggedIn(false);
    }
  }, []);

  useEffect(() => { setReleaseServerUrl(licenseServerUrl()); if (storedAdminToken()) { setLoggedIn(true); refresh(); } }, [refresh]);

  const login = async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await loginLicenseAdmin(username, password); setPassword(""); setLoggedIn(true); await refresh(); }
    catch (loginError) { setError(loginError.message || "Admin login failed."); }
    finally { setBusy(false); }
  };

  const decide = async (item, action) => {
    setBusy(true); setError(""); setMessage("");
    try { if (action === "approve") await approveLicenseRequest(item.id); else await declineLicenseRequest(item.id); await refresh(); setMessage(action === "approve" ? "License approved. The requester will see the code in their browser." : "Request declined."); }
    catch (decisionError) { setError(decisionError.message || "The request could not be updated."); }
    finally { setBusy(false); }
  };

  const logout = async () => { setBusy(true); try { await logoutLicenseAdmin(); } catch { /* local logout still clears the session */ } finally { setLoggedIn(false); setItems([]); setAuditItems([]); setAuditStoragePath(""); setBusy(false); } };

  const updateGithubVariable = async (event) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const result = await updateGithubAgentLicenseServerUrl(releaseServerUrl);
      setMessage(`GitHub variable ${result.name} updated to ${result.value}. New agent releases will use this URL.`);
    } catch (updateError) { setError(updateError.message || "The GitHub variable could not be updated."); }
    finally { setBusy(false); }
  };

  return <AppShell>
    <div className="page-heading"><div><div className="section-kicker"><span className="kicker-line" /> Owner tools</div><h1>License requests</h1><p>Approve one-time activation codes from 10 minutes up to 1 day for trusted website origins.</p></div><div className="heading-note"><ShieldAlert size={16} /><span>Keep this page private</span></div></div>
    {!licenseServerUrl() && <DismissibleMessage className="error-banner" resetKey="license-server-url-missing"><ShieldAlert size={18} /><span>Set NEXT_PUBLIC_LICENSE_SERVER_URL before using the owner dashboard.</span></DismissibleMessage>}
    {!loggedIn ? <section className="agent-pair-card"><div className="card-heading"><div><span className="card-index">01</span><h2>Admin login</h2></div><span className="required-label">Owner only</span></div><p className="card-description">Sign in to approve or decline requests. The default local owner account is Admin / 12345; change this deployment credential before sharing the dashboard.</p><form className="admin-login-form" onSubmit={login}><label>Username<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label><button className="primary-button" type="submit" disabled={busy || !licenseServerUrl()}><LogIn size={17} /> {busy ? "Signing in…" : "Sign in"}</button></form></section> : <><section className="agent-sessions-card"><div className="card-heading"><div><span className="card-index">02</span><h2>Pending and completed requests</h2></div><div className="agent-open-actions"><button className="secondary-button" type="button" onClick={refresh} disabled={busy}><RefreshCw size={16} /> Refresh</button><button className="secondary-button" type="button" onClick={logout} disabled={busy}><LogOut size={16} /> Log out</button></div></div><div className="license-request-list">{items.length ? items.map((item) => <div className="license-request-row" key={item.id}><div><strong>{item.requesterLabel || "Website user"}</strong><small>{item.origin}</small><small>{duration(item.durationMs)} · Created {date(item.createdAt)} · expires {date(item.expiresAt)}</small><small>Status: {item.status}</small></div>{item.status === "pending" && <div className="agent-open-actions"><button className="primary-button" type="button" onClick={() => decide(item, "approve")} disabled={busy}><Check size={16} /> Approve</button><button className="secondary-button" type="button" onClick={() => decide(item, "decline")} disabled={busy}><X size={16} /> Decline</button></div>}</div>) : <div className="agent-session-empty">No license requests yet.</div>}</div></section><section className="agent-pair-card audit-log-card"><div className="card-heading"><div><span className="card-index">03</span><h2><Activity size={18} /> License &amp; device audit</h2></div><button className="secondary-button" type="button" onClick={refresh} disabled={busy}><RefreshCw size={16} /> Refresh log</button></div><p className="card-description">Activation requests, approvals, redemptions, expiries, admin sessions, and device activity are recorded in the SSD licensing database.</p><div className="audit-log-list">{auditItems.length ? auditItems.map((item) => <div className="audit-log-row" key={item.id}><div><strong>{auditLabels[item.event] || item.event}</strong><small>{date(item.createdAt)} · {item.origin || "No browser origin"}{item.requestId ? ` · Request ${item.requestId.slice(0, 8)}` : ""}</small><small>{auditDetailText(item) || "No additional details"}</small></div></div>) : <div className="agent-session-empty">No audit events yet.</div>}</div>{auditStoragePath && <p className="agent-session-note"><LoaderCircle size={14} /> Stored in <code>{auditStoragePath}</code>.</p>}</section><section className="agent-pair-card"><div className="card-heading"><div><span className="card-index">04</span><h2>Release configuration</h2></div><span className="optional-label">Owner only</span></div><p className="card-description">The SSD licensing server updates the GitHub Actions repository variable used by future desktop-agent releases. The GitHub token stays on the licensing server and is never sent to this page.</p><form className="admin-login-form" onSubmit={updateGithubVariable}><label>Agent licensing-server URL<input value={releaseServerUrl} onChange={(event) => setReleaseServerUrl(event.target.value)} placeholder="https://your-device.tailnet.ts.net" autoComplete="url" /></label><button className="primary-button" type="submit" disabled={busy || !releaseServerUrl}><Github size={17} /> {busy ? "Updating…" : "Update GitHub variable"}</button></form><p className="agent-session-note"><LoaderCircle size={14} /> Use the HTTPS Tailscale Funnel URL. Future releases embed it as <code>AGENT_LICENSE_SERVER_URL</code>.</p></section></>}
    {message && <div className="success-banner"><Check size={17} /><span>{message}</span></div>}
    {error && <DismissibleMessage className="error-banner" resetKey={error}><ShieldAlert size={17} /><span>{error}</span></DismissibleMessage>}
    {loggedIn && <p className="agent-session-note"><LoaderCircle size={14} /> Click Refresh to load the latest requests. The activation code is shown only to the requesting browser, not in this owner list.</p>}
  </AppShell>;
}
