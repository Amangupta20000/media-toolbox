"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, Download, FileDown, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { MockApiError, MOCK_METHODS, normalizeMockProject } from "../lib/mock-api.js";
import { pushAnalyticsEvent } from "../lib/analytics.js";
import { probeLocalAgent } from "./processing-client.js";
import { deleteLocalMockProject, exportMockProject, importMockProject, listLocalMockProjects, localMockApiUrl, mockCurlExample, mockFetchExample, saveBrowserMockProject, saveLocalMockProject, simulateMockRequest } from "./mock-api-client.js";
import { AppShell } from "./app-shell.jsx";

const DEFAULT_PROJECT = { name: "Frontend mock API", id: "frontend-mock", collections: [{ name: "users", methods: MOCK_METHODS, records: [{ id: "1", name: "Ada Lovelace", role: "admin" }] }] };

function initialProject() { return normalizeMockProject(DEFAULT_PROJECT); }

function downloadText(filename, value) {
  const blob = new Blob([value], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

function MockDiagram() {
  return <svg className="mock-api-diagram" viewBox="0 0 860 190" role="img" aria-labelledby="mock-api-diagram-title mock-api-diagram-description">
    <title id="mock-api-diagram-title">Browser simulation and Local agent mock API paths</title>
    <desc id="mock-api-diagram-description">Browser mode simulates requests in this tab. Local agent saves a project and serves it from localhost.</desc>
    <defs><linearGradient id="mock-flow" x1="0" x2="1"><stop stopColor="#38d4cf" /><stop offset="1" stopColor="#81e6c4" /></linearGradient></defs>
    <rect x="16" y="25" width="246" height="138" rx="18" className="mock-diagram-card" /><rect x="598" y="25" width="246" height="138" rx="18" className="mock-diagram-card" />
    <path d="M262 74h260c35 0 48-23 76-23" className="mock-diagram-line" /><path d="M262 118h260c35 0 48 23 76 23" className="mock-diagram-line" />
    <circle cx="342" cy="74" r="5" className="mock-diagram-dot" /><circle cx="462" cy="74" r="5" className="mock-diagram-dot" /><circle cx="398" cy="118" r="5" className="mock-diagram-dot" />
    <text x="40" y="62" className="mock-diagram-label">Your frontend</text><text x="40" y="92" className="mock-diagram-copy">Choose Browser mode</text><text x="40" y="119" className="mock-diagram-copy">or Local agent</text>
    <text x="620" y="62" className="mock-diagram-label">JSON REST mock</text><text x="620" y="92" className="mock-diagram-copy">Browser: this tab only</text><text x="620" y="119" className="mock-diagram-copy">Local: 127.0.0.1</text>
  </svg>;
}

function SectionHeading({ id, children, detail }) { return <div className="mock-api-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Mock API beta</div><h2 id={id}>{children}</h2></div>{detail && <p>{detail}</p>}</div>; }

function MethodToggle({ method, active, onClick }) { return <button type="button" className={`mock-method ${active ? "active" : ""}`} aria-pressed={active} onClick={onClick}>{method}</button>; }

function ResponsePanel({ response }) {
  if (!response) return <div className="mock-response-empty">Run a request to see the status, headers, and JSON response.</div>;
  return <div className="mock-response"><div className="mock-response-status"><strong className={response.status >= 400 ? "error" : "success"}>{response.status}</strong><span>{response.status === 204 ? "No content" : "JSON response"}</span></div><pre>{JSON.stringify(response.body, null, 2) || ""}</pre><details><summary>Headers</summary><pre>{JSON.stringify(response.headers, null, 2)}</pre></details></div>;
}

export function MockApiPage() {
  const [project, setProject] = useState(initialProject);
  const [seedText, setSeedText] = useState(() => initialProject().collections.map((collection) => JSON.stringify(collection.records, null, 2)));
  const [activeTab, setActiveTab] = useState("browser");
  const [path, setPath] = useState("/users");
  const [method, setMethod] = useState("GET");
  const [requestBody, setRequestBody] = useState("");
  const [response, setResponse] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [localProjects, setLocalProjects] = useState([]);
  const [agentStatus, setAgentStatus] = useState(null);
  const fileInput = useRef(null);

  const currentCollection = useMemo(() => project.collections.find((collection) => path.replace(/^\//, "").split("/")[0] === collection.name), [path, project.collections]);
  const availableMethods = currentCollection?.methods || MOCK_METHODS;

  useEffect(() => { if (!availableMethods.includes(method)) setMethod(availableMethods[0] || "GET"); }, [availableMethods, method]);
  useEffect(() => { if (activeTab === "local" || activeTab === "history") probeLocalAgent().then(setAgentStatus).catch((cause) => setAgentStatus({ available: false, error: cause.message })); }, [activeTab]);
  useEffect(() => { if (activeTab !== "history") return; listLocalMockProjects().then(setLocalProjects).catch((cause) => setError(cause.message)); }, [activeTab]);

  const projectFromEditor = () => {
    const collections = project.collections.map((collection, index) => {
      let records;
      try { records = JSON.parse(seedText[index] || "[]"); } catch { throw new MockApiError(`The ${collection.name} seed data is not valid JSON.`); }
      return { ...collection, records };
    });
    return normalizeMockProject({ ...project, collections });
  };

  const updateCollection = (index, changes) => {
    setProject((current) => ({ ...current, collections: current.collections.map((collection, itemIndex) => itemIndex === index ? { ...collection, ...changes } : collection) }));
    pushAnalyticsEvent("mock_api_collection_changed", { surface: "workspace", mode: activeTab });
  };

  const addCollection = () => { setProject((current) => ({ ...current, collections: [...current.collections, { name: `collection${current.collections.length + 1}`, methods: ["GET"], records: [] }] })); setSeedText((current) => [...current, "[]"]); };

  const saveBrowser = async () => {
    try { const next = projectFromEditor(); await saveBrowserMockProject(next); setProject(next); setNotice("Saved in this browser profile."); setError(""); pushAnalyticsEvent("mock_api_project_created", { surface: "workspace", mode: "browser" }); }
    catch (cause) { setError(cause.message); }
  };

  const runRequest = async () => {
    try {
      const next = projectFromEditor();
      let body;
      if (requestBody.trim()) { try { body = JSON.parse(requestBody); } catch { throw new MockApiError("Request body is not valid JSON."); } }
      const result = simulateMockRequest(next, { method, pathname: path, body });
      setResponse(result); setProject(result.project); setSeedText(result.project.collections.map((collection) => JSON.stringify(collection.records, null, 2))); setError("");
      await saveBrowserMockProject(result.project);
      pushAnalyticsEvent("mock_api_request_simulated", { surface: "request_console", mode: "browser", method });
    } catch (cause) { setError(cause.message); setResponse({ status: cause.status || 400, headers: cause.headers || {}, body: { error: cause.message, code: cause.code || "mock_api_error" } }); }
  };

  const saveLocal = async () => {
    try { const next = projectFromEditor(); const saved = await saveLocalMockProject(next); setProject(saved); setNotice("Saved to the Local agent Results folder. The localhost API is available while authorization is active."); setError(""); setActiveTab("local"); pushAnalyticsEvent("mock_api_local_saved", { surface: "workspace", mode: "local" }); pushAnalyticsEvent("mock_api_local_host_started", { surface: "workspace", mode: "local" }); }
    catch (cause) { setError(cause.message); }
  };

  const loadProject = (value) => { const next = normalizeMockProject(value); setProject(next); setSeedText(next.collections.map((collection) => JSON.stringify(collection.records, null, 2))); setResponse(null); setError(""); setActiveTab("browser"); };
  const duplicateProject = (value) => loadProject({ ...value, id: undefined, name: `${value.name} copy` });
  const exportCurrent = () => { try { const next = projectFromEditor(); downloadText(`${next.id}.json`, exportMockProject(next)); } catch (cause) { setError(cause.message); } };
  const importFile = async (event) => { const file = event.target.files?.[0]; if (!file) return; try { loadProject(await importMockProject(await file.text())); setNotice("Project imported into Browser mode."); } catch (cause) { setError(cause.message); } event.target.value = ""; };
  const copy = async (value) => { await navigator.clipboard?.writeText(value); setNotice("Copied to clipboard."); };

  return <AppShell>
    <article className="mock-api-page">
      <header className="mock-api-hero"><div className="section-kicker"><span className="kicker-line" /> Build a local API</div><h1>Mock API for frontend testing</h1><p>Create JSON REST endpoints for your frontend while the real API is still being built.</p><MockDiagram /><div className="mock-api-summary"><strong>Browser mode simulates requests in this tab.</strong> Save the same validated project to Local agent when you need a localhost endpoint.</div></header>
      <nav className="mock-api-tabs" aria-label="Mock API workspace"><button className={activeTab === "browser" ? "active" : ""} onClick={() => setActiveTab("browser")}>Browser designer</button><button className={activeTab === "local" ? "active" : ""} onClick={() => setActiveTab("local")}>Local agent</button><button className={activeTab === "history" ? "active" : ""} onClick={() => setActiveTab("history")}>Mock API History</button><button className={activeTab === "guide" ? "active" : ""} onClick={() => setActiveTab("guide")}>Helpful guide</button></nav>
      {error && <div className="mock-api-alert error" role="alert">{error}</div>}{notice && <div className="mock-api-alert success" role="status">{notice}</div>}
      {activeTab === "browser" && <>
        <section className="mock-api-workspace" aria-labelledby="mock-project-title"><SectionHeading id="mock-project-title">Design your project</SectionHeading><div className="mock-api-project-fields"><label>Project name<input value={project.name} onChange={(event) => setProject((current) => ({ ...current, name: event.target.value }))} /></label><label>Project ID<input value={project.id} onChange={(event) => setProject((current) => ({ ...current, id: event.target.value }))} /><small>Letters, numbers, hyphens, and underscores only.</small></label></div>
          <div className="mock-collections">{project.collections.map((collection, index) => <article className="mock-collection-card" key={`${collection.name}-${index}`}><div className="mock-collection-header"><label>Collection name<input value={collection.name} onChange={(event) => updateCollection(index, { name: event.target.value })} /></label><button type="button" className="icon-button" title="Remove collection" aria-label={`Remove ${collection.name}`} onClick={() => { setProject((current) => ({ ...current, collections: current.collections.filter((_, itemIndex) => itemIndex !== index) })); setSeedText((current) => current.filter((_, itemIndex) => itemIndex !== index)); }}><Trash2 size={16} /></button></div><div className="mock-methods" aria-label={`${collection.name} methods`}>{MOCK_METHODS.map((entry) => <MethodToggle key={entry} method={entry} active={collection.methods.includes(entry)} onClick={() => updateCollection(index, { methods: collection.methods.includes(entry) ? collection.methods.filter((value) => value !== entry) : [...collection.methods, entry] })} />)}</div><label className="mock-seed-label">Seed records (JSON array)<textarea value={seedText[index] || "[]"} onChange={(event) => setSeedText((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))} spellCheck="false" /></label></article>)}</div><button type="button" className="secondary-button" onClick={addCollection}><Plus size={16} /> Add collection</button><div className="mock-api-actions"><button type="button" className="primary-button" onClick={saveBrowser}><Check size={16} /> Save in Browser mode</button><button type="button" className="secondary-button" onClick={exportCurrent}><Download size={16} /> Export JSON</button><button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}><Upload size={16} /> Import JSON</button><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={importFile} /></div></section>
        <section className="mock-api-workspace" aria-labelledby="mock-console-title"><SectionHeading id="mock-console-title">Request simulator</SectionHeading><p className="mock-api-note">Browser mode previews the API in this tab; it does not expose a network URL.</p><div className="mock-request-grid"><label>Method<select value={method} onChange={(event) => setMethod(event.target.value)}>{availableMethods.map((entry) => <option key={entry}>{entry}</option>)}</select></label><label>Path<input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/users or /users/1" /></label></div><label>JSON body (for POST, PUT, or PATCH)<textarea value={requestBody} onChange={(event) => setRequestBody(event.target.value)} placeholder={'{\n  "name": "New user"\n}'} spellCheck="false" /></label><button type="button" className="primary-button" onClick={runRequest}>Run request <RefreshCw size={16} /></button><ResponsePanel response={response} /></section>
      </>}
      {activeTab === "local" && <section className="mock-api-workspace" aria-labelledby="mock-local-title"><SectionHeading id="mock-local-title">Host with Local agent</SectionHeading><div className={`mock-agent-status ${agentStatus?.connected ? "connected" : ""}`}><span className="status-pulse" /><div><strong>{agentStatus?.connected ? "Local agent authorized" : "Local agent not ready"}</strong><p>{agentStatus?.connected ? "Projects are stored in Results/mock-apis and served from 127.0.0.1." : "Authorize the Local agent, then return here to save a project."}</p></div><Link className="secondary-button" href="/local-agent">Check connection</Link></div><div className="mock-api-actions"><button type="button" className="primary-button" onClick={saveLocal}><FileDown size={16} /> Save to Local agent</button><button type="button" className="secondary-button" onClick={exportCurrent}><Download size={16} /> Export JSON</button></div><div className="mock-api-code"><h3>Integration base URL</h3><code>{localMockApiUrl(project.id)}</code><button className="icon-button" onClick={() => copy(localMockApiUrl(project.id))} title="Copy base URL"><Copy size={16} /></button><h3>fetch example</h3><pre>{mockFetchExample(project.id)}</pre><button className="secondary-button" onClick={() => copy(mockFetchExample(project.id))}><Copy size={15} /> Copy fetch</button><h3>cURL example</h3><pre>{mockCurlExample(project.id)}</pre><button className="secondary-button" onClick={() => copy(mockCurlExample(project.id))}><Copy size={15} /> Copy cURL</button></div><p className="mock-api-note">The agent binds to <code>127.0.0.1</code> by default. If you intentionally share it through Tailscale or a tunnel, apply your own authentication and access controls; v1 does not create public HTTPS URLs.</p></section>}
      {activeTab === "history" && <section className="mock-api-workspace" aria-labelledby="mock-history-title"><SectionHeading id="mock-history-title">Mock API History</SectionHeading>{!agentStatus?.connected && <p className="mock-api-note">Connect and authorize the Local agent to view projects saved in its Results folder.</p>}<div className="mock-history-list">{localProjects.map((item) => <article className="mock-history-item" key={item.id}><div><strong>{item.name}</strong><small>{item.id} · {item.collections.length} collection{item.collections.length === 1 ? "" : "s"}</small></div><div className="mock-history-actions"><button onClick={() => loadProject(item)}>Edit</button><button onClick={() => duplicateProject(item)}>Duplicate</button><button onClick={() => downloadText(`${item.id}.json`, exportMockProject(item))}>Export</button><button onClick={() => copy(localMockApiUrl(item.id))}>Copy URL</button><button className="danger" onClick={async () => { await deleteLocalMockProject(item.id); setLocalProjects((current) => current.filter((entry) => entry.id !== item.id)); pushAnalyticsEvent("mock_api_project_deleted", { surface: "history", mode: "local" }); }}>Delete</button></div></article>)}</div></section>}
      {activeTab === "guide" && <section className="mock-api-guide" aria-labelledby="mock-guide-title"><SectionHeading id="mock-guide-title">A practical mock API for development</SectionHeading><p>Use this tool to build a predictable JSON REST contract before your production backend is ready. Browser mode is a simulator; Local agent is a localhost service for a frontend running on your computer.</p><div className="mock-guide-table-wrap"><table><thead><tr><th>Need</th><th>Browser mode</th><th>Local agent</th></tr></thead><tbody><tr><th>External frontend can call it</th><td>No, simulation stays in this tab</td><td>Yes, from a local app via 127.0.0.1</td></tr><tr><th>Storage</th><td>IndexedDB in this browser profile</td><td>Results/mock-apis on the connected computer</td></tr><tr><th>Methods</th><td>GET, POST, PUT, PATCH, DELETE</td><td>GET, POST, PUT, PATCH, DELETE, OPTIONS</td></tr><tr><th>Public HTTPS URL</th><td>Not available in v1</td><td>Use your own tunnel deliberately</td></tr></tbody></table></div><h3>REST behavior</h3><p>GET reads records, POST creates one, PUT replaces one, PATCH updates selected fields, and DELETE removes one. Collection methods can be disabled. Invalid JSON returns 400, missing resources return 404, and disabled methods return 405.</p><h3>Safety limits</h3><p>Projects are limited to 20 collections, 1,000 records per collection, and a 1 MB manifest. Request and response bodies are limited to 256 KB. No user-authored code is executed.</p><div className="mock-api-faq"><h3>Frequently asked questions</h3><details open><summary>Does Browser mode create a real URL?</summary><p>No. It simulates the request in the current tab and does not send mock definitions or records to the website backend.</p></details><details><summary>Can Local agent keep serving when the website closes?</summary><p>Yes. Once saved and authorized, the agent reads the project from its Results folder and serves localhost requests independently until authorization expires or is revoked.</p></details><details><summary>Can I expose it to the internet?</summary><p>Not directly in v1. If you use a tunnel, configure it yourself and add authentication, rate limits, and a restricted audience.</p></details></div></section>}
    </article>
  </AppShell>;
}
