"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, Download, FileDown, FileText, Play, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { MockApiError, MOCK_METHODS, normalizeMockProject, parseMockCurl } from "../lib/mock-api.js";
import { pushAnalyticsEvent } from "../lib/analytics.js";
import { probeLocalAgent } from "./processing-client.js";
import { deleteLocalMockProject, exportMockProject, importMockProject, listLocalMockProjects, localMockApiUrl, mockCurlExample, mockFetchExample, saveLocalMockProject, simulateMockRequest } from "./mock-api-client.js";
import { AppShell } from "./app-shell.jsx";

const DRAFT_STORAGE_KEY = "native-media-agent:mock-api-workspace";
const DEFAULT_PROJECT = { name: "Frontend mock API", id: "frontend-mock", mode: "database", collections: [], endpoints: [] };

function initialProject() { return normalizeMockProject(DEFAULT_PROJECT); }
function pretty(value) { return JSON.stringify(value, null, 2); }
function downloadText(filename, value) { const blob = new Blob([value], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function endpointId(method, path) { const value = `${method}-${path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); return (value || "api").startsWith("api") ? value || "api" : `api-${value || "endpoint"}`; }
function parseJsonText(text, label, fallback = null) { if (!String(text || "").trim()) return fallback; try { return JSON.parse(text); } catch { throw new MockApiError(`${label} must be valid JSON.`); } }
function projectCollections(project) { return Array.isArray(project?.collections) ? project.collections : []; }
function projectEndpoints(project) { return Array.isArray(project?.endpoints) ? project.endpoints : []; }
function collectionFromPath(path) { const firstSegment = String(path || "").split("?")[0].split("/").filter(Boolean)[0] || "users"; const safeName = firstSegment.replace(/[^a-zA-Z0-9_-]/g, ""); return safeName || "users"; }
function emptyDraft(project) { const collections = projectCollections(project); const collection = collections[0]?.name || "users"; const records = collections[0]?.records || []; return { endpointId: "", name: "", method: "GET", path: `/${collection}`, collection, requestHeaders: "{}", requestBody: "", successStatus: "200", successHeaders: '{\n  "Content-Type": "application/json"\n}', successBody: "{\n  \"message\": \"ok\"\n}", successOverride: false, errorStatus: "400", errorHeaders: '{\n  "Content-Type": "application/json"\n}', errorBody: '{\n  "error\": \"Mock API error\"\n}', seedText: pretty(records) }; }
function endpointDraft(project, endpointIdValue) {
  const endpoint = projectEndpoints(project).find((item) => item.id === endpointIdValue) || projectEndpoints(project)[0];
  const collections = projectCollections(project);
  const collection = endpoint?.collection || collections[0]?.name || "users";
  const records = collections.find((item) => item.name === collection)?.records || [];
  return endpoint ? { endpointId: endpoint.id, name: endpoint.name, method: endpoint.method, path: endpoint.path, collection, requestHeaders: pretty(endpoint.request?.headers || {}), requestBody: endpoint.request?.body ? pretty(endpoint.request.body) : "", successStatus: String(endpoint.responses?.success?.status || 200), successHeaders: pretty(endpoint.responses?.success?.headers || {}), successBody: pretty(endpoint.responses?.success?.body ?? {}), successOverride: Boolean(endpoint.responses?.success?.override), errorStatus: String(endpoint.responses?.error?.status || 400), errorHeaders: pretty(endpoint.responses?.error?.headers || {}), errorBody: pretty(endpoint.responses?.error?.body ?? { error: "Mock API error" }), seedText: pretty(records) } : emptyDraft(project);
}

function MockDiagram() { return <svg className="mock-api-diagram" viewBox="0 0 860 190" role="img" aria-labelledby="mock-api-diagram-title mock-api-diagram-description"><title id="mock-api-diagram-title">Postman-style local mock API workflow</title><desc id="mock-api-diagram-description">Configure a request, run it, inspect the response, and save a callable Local-agent URL.</desc><defs><linearGradient id="mock-flow" x1="0" x2="1"><stop stopColor="#38d4cf" /><stop offset="1" stopColor="#81e6c4" /></linearGradient></defs><rect x="16" y="25" width="246" height="138" rx="18" className="mock-diagram-card" /><rect x="598" y="25" width="246" height="138" rx="18" className="mock-diagram-card" /><path d="M262 74h260c35 0 48-23 76-23" className="mock-diagram-line" /><path d="M262 118h260c35 0 48 23 76 23" className="mock-diagram-line" /><circle cx="342" cy="74" r="5" className="mock-diagram-dot" /><circle cx="462" cy="74" r="5" className="mock-diagram-dot" /><circle cx="398" cy="118" r="5" className="mock-diagram-dot" /><text x="40" y="62" className="mock-diagram-label">Build a request</text><text x="40" y="92" className="mock-diagram-copy">Send JSON locally</text><text x="40" y="119" className="mock-diagram-copy">Save when it works</text><text x="620" y="62" className="mock-diagram-label">Test and copy</text><text x="620" y="92" className="mock-diagram-copy">Inspect the response</text><text x="620" y="119" className="mock-diagram-copy">One project, many APIs</text></svg>; }
function SectionHeading({ id, children, detail }) { return <div className="mock-api-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Mock API beta</div><h2 id={id}>{children}</h2></div>{detail && <p>{detail}</p>}</div>; }
function ResponsePanel({ response }) {
  const [tab, setTab] = useState("body");
  if (!response) return <div className="mock-response-empty">Send a request to see the status, headers, and JSON response.</div>;
  return <div className="mock-response mock-postman-response"><div className="mock-response-status"><strong className={response.status >= 400 ? "error" : "success"}>{response.status}</strong><span>{response.status === 204 ? "No content" : "JSON response"}</span>{response.durationMs !== undefined && <small>{response.durationMs} ms</small>}</div><div className="mock-response-tabs"><button type="button" className={tab === "body" ? "active" : ""} onClick={() => setTab("body")}>Body</button><button type="button" className={tab === "headers" ? "active" : ""} onClick={() => setTab("headers")}>Headers</button></div>{tab === "body" ? <pre>{response.body == null ? "" : JSON.stringify(response.body, null, 2)}</pre> : <pre>{JSON.stringify(response.headers || {}, null, 2)}</pre>}</div>;
}

function PostmanWorkbench(props) { return <SeparatedPostmanWorkbench {...props} />; }

function SimpleGetWorkbench({ project, draft, endpoints, response, savedUrl, exampleHeaders, curlText, onDraftChange, onNewApi, onSelectEndpoint, onRun, onSave, onImportCurl, onCurlChange, onCopy, onExport, onImport, onClearDraft, fileInput, onProjectChange, onProjectIdChange }) {
  const [scenario, setScenario] = useState("success");
  const setValue = (key, value) => onDraftChange({ ...draft, [key]: value });
  const currentId = draft.endpointId;
  const savedEndpoint = endpoints.find((item) => item.id === currentId);
  const baseUrl = localMockApiUrl(project.id, "").replace(/\/$/, "");
  return <section className="mock-postman-shell mock-simple-get-shell" aria-label="Simple GET API workspace">
    <aside className="mock-api-sidebar">
      <div className="mock-sidebar-heading"><div><span className="section-kicker"><span className="kicker-line" /> Project</span><h2>{project.name}</h2></div><button type="button" className="icon-button" title="Create a new API" onClick={onNewApi}><Plus size={18} /></button></div>
      <label className="mock-sidebar-field">Project name<input value={project.name} onChange={(event) => onProjectChange(event.target.value)} /></label>
      <label className="mock-sidebar-field">Project ID<input value={project.id} onChange={(event) => onProjectIdChange(event.target.value)} /><small>Letters, numbers, hyphens, and underscores.</small></label>
      <div className="mock-sidebar-divider" /><div className="mock-sidebar-list-heading"><strong>Saved APIs</strong><span>{endpoints.length}</span></div>
      <div className="mock-sidebar-list">{endpoints.length ? endpoints.map((endpoint) => <button type="button" key={endpoint.id} className={`mock-sidebar-endpoint ${endpoint.id === currentId ? "active" : ""}`} onClick={() => onSelectEndpoint(endpoint.id)}><span className="mock-saved-method">{endpoint.method}</span><span><strong>{endpoint.name}</strong><small>{endpoint.path}</small></span></button>) : <p className="mock-sidebar-empty">Your saved APIs will appear here.</p>}</div>
      <button type="button" className="mock-sidebar-clear" onClick={onClearDraft}>Clear current draft</button>
    </aside>
    <div className="mock-postman-main">
      <div className="mock-postman-toolbar"><div><span className="section-kicker"><span className="kicker-line" /> Quick GET</span><h2>{draft.name || "New GET endpoint"}</h2></div><div className="mock-draft-retained"><Check size={14} /> Draft retained in this browser</div></div>
      <div className="mock-request-bar"><select aria-label="Request method" value={draft.method} onChange={(event) => setValue("method", event.target.value)}>{MOCK_METHODS.map((method) => <option key={method}>{method}</option>)}</select><div className="mock-request-url"><span>{baseUrl}</span><input aria-label="API path" value={draft.path} onChange={(event) => setValue("path", event.target.value)} placeholder="/users" /></div><button type="button" className="primary-button mock-send-button" onClick={() => onRun(scenario)}><Play size={16} /> Send</button></div>
      <div className="mock-request-meta"><label>API name<input value={draft.name} onChange={(event) => setValue("name", event.target.value)} placeholder="GET /users" /></label><span className="mock-local-badge">Local agent · fixed JSON response</span></div>
      <div className="mock-simple-get-copy"><strong>Simple GET endpoint</strong><p>Enter the JSON you want this URL to return. Headers, error responses, and status codes are available under Advanced options.</p></div>
      <label className="mock-simple-response-label">JSON response <span className="mock-field-hint">Returned on success</span><textarea value={draft.successBody} onChange={(event) => setValue("successBody", event.target.value)} spellCheck="false" /></label>
      <div className="mock-response-heading"><div><span className="section-kicker"><span className="kicker-line" /> Response</span><h3>{response ? "Latest response" : "Run the request"}</h3></div>{response && <span className="mock-response-live">Local simulation</span>}</div>
      <ResponsePanel response={response} />
      <details className="mock-request-options mock-simple-advanced"><summary>Advanced response options</summary><div className="mock-options-grid"><label>Scenario<select value={scenario} onChange={(event) => setScenario(event.target.value)}><option value="success">Success response</option><option value="error">Error response</option></select></label><label>Success status<input value={draft.successStatus} onChange={(event) => setValue("successStatus", event.target.value)} inputMode="numeric" /></label><label>Error status<input value={draft.errorStatus} onChange={(event) => setValue("errorStatus", event.target.value)} inputMode="numeric" /></label><label>Success headers<textarea value={draft.successHeaders} onChange={(event) => setValue("successHeaders", event.target.value)} spellCheck="false" /></label><label>Error headers<textarea value={draft.errorHeaders} onChange={(event) => setValue("errorHeaders", event.target.value)} spellCheck="false" /></label><label className="mock-option-wide">Error response<textarea value={draft.errorBody} onChange={(event) => setValue("errorBody", event.target.value)} spellCheck="false" /></label></div></details>
      <details className="mock-curl-import"><summary><FileText size={16} /> Import request from cURL</summary><div><textarea value={curlText} onChange={(event) => onCurlChange(event.target.value)} spellCheck="false" placeholder="Paste a GET cURL command here" /><button type="button" className="secondary-button" onClick={onImportCurl}><Upload size={16} /> Import request</button><small>Nothing is executed. Sensitive header values are redacted.</small></div></details>
      {savedEndpoint && <div className="mock-saved-inline"><div><Check size={17} /><strong>Saved to Local agent</strong><small>Callable while authorization is active</small></div><code>{savedUrl}</code><button type="button" className="secondary-button" onClick={() => onCopy(savedUrl)}><Copy size={15} /> Copy URL</button></div>}
      <div className="mock-postman-actions"><button type="button" className="primary-button" onClick={onSave}><FileDown size={16} /> Save API to Local agent</button><button type="button" className="secondary-button" onClick={() => onCopy(mockFetchExample(project.id, { method: "GET", pathname: draft.path, headers: exampleHeaders }))}><Copy size={15} /> Copy fetch</button><button type="button" className="secondary-button" onClick={() => onCopy(mockCurlExample(project.id, { method: "GET", pathname: draft.path, headers: exampleHeaders }))}><Copy size={15} /> Copy cURL</button><button type="button" className="secondary-button" onClick={onExport}><Download size={16} /> Export</button><button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}><Upload size={16} /> Import</button><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={onImport} /></div>
    </div>
  </section>;
}

function MockWorkspaceSidebar({ project, endpoints, currentId, onNewApi, onSelectEndpoint, onClearDraft, onProjectChange, onProjectIdChange }) { return <aside className="mock-api-sidebar"><div className="mock-sidebar-heading"><div><span className="section-kicker"><span className="kicker-line" /> Project</span><h2>{project.name}</h2></div><button type="button" className="icon-button" title="Create a new API" onClick={onNewApi}><Plus size={18} /></button></div><label className="mock-sidebar-field">Project name<input value={project.name} onChange={(event) => onProjectChange(event.target.value)} /></label><label className="mock-sidebar-field">Project ID<input value={project.id} onChange={(event) => onProjectIdChange(event.target.value)} /><small>Letters, numbers, hyphens, and underscores.</small></label><div className="mock-sidebar-divider" /><div className="mock-sidebar-list-heading"><strong>Saved APIs</strong><span>{endpoints.length}</span></div><div className="mock-sidebar-list">{endpoints.length ? endpoints.map((endpoint) => <button type="button" key={endpoint.id} className={`mock-sidebar-endpoint ${endpoint.id === currentId ? "active" : ""}`} onClick={() => onSelectEndpoint(endpoint.id)}><span className="mock-saved-method">{endpoint.method}</span><span><strong>{endpoint.name}</strong><small>{endpoint.path}</small></span></button>) : <p className="mock-sidebar-empty">Your saved APIs will appear here.</p>}</div><button type="button" className="mock-sidebar-clear" onClick={onClearDraft}>Clear current draft</button></aside>; }

function SeparatedPostmanWorkbench({ project, draft, endpoints, isDatabase, response, savedUrl, exampleHeaders, curlText, onDraftChange, onNewApi, onSelectEndpoint, onRun, onSave, onImportCurl, onCurlChange, onCopy, onExport, onImport, onClearDraft, fileInput, onProjectChange, onProjectIdChange }) {
  const [workspaceTab, setWorkspaceTab] = useState("create");
  const [scenario, setScenario] = useState("success");
  const setValue = (key, value) => onDraftChange({ ...draft, [key]: value });
  const simpleGet = !isDatabase && draft.method === "GET";
  const databaseGet = isDatabase && draft.method === "GET";
  const isBodyMethod = !["GET", "DELETE"].includes(draft.method);
  const baseUrl = localMockApiUrl(project.id, "").replace(/\/$/, "");
  const savedEndpoint = endpoints.find((item) => item.id === draft.endpointId);
  return <section className="mock-postman-shell" aria-label="Mock API workspace"><MockWorkspaceSidebar project={project} endpoints={endpoints} currentId={draft.endpointId} onNewApi={onNewApi} onSelectEndpoint={onSelectEndpoint} onClearDraft={onClearDraft} onProjectChange={onProjectChange} onProjectIdChange={onProjectIdChange} /><div className="mock-postman-main"><div className="mock-postman-toolbar"><div><span className="section-kicker"><span className="kicker-line" /> Workspace</span><h2>{workspaceTab === "create" ? "Create API" : "Simulate API"}</h2></div><div className="mock-draft-retained"><Check size={14} /> Draft retained in this browser</div></div><div className="mock-workspace-tabs" role="tablist" aria-label="API workspace tabs"><button type="button" role="tab" aria-selected={workspaceTab === "create"} className={workspaceTab === "create" ? "active" : ""} onClick={() => setWorkspaceTab("create")}>Create API</button><button type="button" role="tab" aria-selected={workspaceTab === "simulate"} className={workspaceTab === "simulate" ? "active" : ""} onClick={() => setWorkspaceTab("simulate")}>Simulate</button></div>{workspaceTab === "create" ? <>
    <div className="mock-pane-intro"><strong>{simpleGet ? "Simple GET endpoint" : databaseGet ? "Create your JSON database" : "Configure endpoint"}</strong><p>{simpleGet ? "Enter the JSON this route should return. Advanced response settings stay out of the way until you need them." : databaseGet ? "Add one JSON array of objects. Saving this GET creates the shared database used by later POST, PUT, PATCH, and DELETE APIs." : "Define the request and response contract, then save this API to the Local agent."}</p></div>
    <div className="mock-request-bar"><select aria-label="Request method" value={draft.method} onChange={(event) => setValue("method", event.target.value)}>{MOCK_METHODS.map((method) => <option key={method}>{method}</option>)}</select><div className="mock-request-url"><span>{baseUrl}</span><input aria-label="API path" value={draft.path} onChange={(event) => setValue("path", event.target.value)} placeholder="/users" /></div><button type="button" className="secondary-button" onClick={() => setWorkspaceTab("simulate")}><Play size={16} /> Test</button></div>
    <div className="mock-request-meta"><label>API name<input value={draft.name} onChange={(event) => setValue("name", event.target.value)} placeholder={`${draft.method} ${draft.path}`} /></label><span className="mock-local-badge">Local agent · {isDatabase ? "dummy database" : "fixed response"}</span></div>
    {simpleGet || databaseGet ? <label className="mock-simple-response-label">{databaseGet ? "JSON config" : "JSON response"} <span className="mock-field-hint">{databaseGet ? "Array of objects becomes the shared dummy database" : "Returned on success"}</span><textarea value={databaseGet ? draft.seedText : draft.successBody} onChange={(event) => setValue(databaseGet ? "seedText" : "successBody", event.target.value)} spellCheck="false" />{databaseGet && <small className="mock-field-help">Use an array of JSON objects, for example <code>[&#123; "id": "1", "name": "Ada" &#125;]</code>. The route name becomes the collection name, so later CRUD APIs can use the same data.</small>}</label> : <div className="mock-create-fields"><label>Request headers <span className="mock-field-hint">JSON object</span><textarea value={draft.requestHeaders} onChange={(event) => setValue("requestHeaders", event.target.value)} spellCheck="false" /></label>{isBodyMethod && <label>Request body (JSON)<textarea value={draft.requestBody} onChange={(event) => setValue("requestBody", event.target.value)} spellCheck="false" placeholder={'{\n  "name": "New item"\n}'} /></label>}</div>}
    {isDatabase && !databaseGet && <div className="mock-db-use-note"><strong>Uses the JSON database for <code>/{collectionFromPath(draft.path)}</code></strong><p>This API reads and changes the records created by the GET setup. The collection is inferred from the route.</p></div>}
    {!databaseGet && <details className="mock-request-options mock-simple-advanced" open={!simpleGet}><summary>{simpleGet ? "Advanced response options" : "Response configuration"}</summary><div className="mock-options-grid"><label>Success status<input value={draft.successStatus} onChange={(event) => setValue("successStatus", event.target.value)} inputMode="numeric" /></label><label>Error status<input value={draft.errorStatus} onChange={(event) => setValue("errorStatus", event.target.value)} inputMode="numeric" /></label><label>Success headers<textarea value={draft.successHeaders} onChange={(event) => setValue("successHeaders", event.target.value)} spellCheck="false" /></label><label>Success response<textarea value={draft.successBody} onChange={(event) => setValue("successBody", event.target.value)} spellCheck="false" /></label><label>Error headers<textarea value={draft.errorHeaders} onChange={(event) => setValue("errorHeaders", event.target.value)} spellCheck="false" /></label><label>Error response<textarea value={draft.errorBody} onChange={(event) => setValue("errorBody", event.target.value)} spellCheck="false" /></label></div></details>}
    <details className="mock-curl-import"><summary><FileText size={16} /> Import request from cURL</summary><div><textarea value={curlText} onChange={(event) => onCurlChange(event.target.value)} spellCheck="false" placeholder="Paste a cURL command here" /><button type="button" className="secondary-button" onClick={onImportCurl}><Upload size={16} /> Import request</button><small>Nothing is executed. Sensitive header values are redacted.</small></div></details>
    <div className="mock-postman-actions"><button type="button" className="primary-button" onClick={onSave}><FileDown size={16} /> Save API to Local agent</button><button type="button" className="secondary-button" onClick={onExport}><Download size={16} /> Export</button><button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}><Upload size={16} /> Import</button><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={onImport} /></div>
  </> : <>
    <div className="mock-pane-intro"><strong>Send requests without changing the API definition</strong><p>{savedEndpoint ? `Testing ${savedEndpoint.name}.` : "Configure an API in the Create API tab, then send it here."}</p></div>
    <div className="mock-request-bar"><select aria-label="Simulation method" value={draft.method} onChange={(event) => setValue("method", event.target.value)}>{MOCK_METHODS.map((method) => <option key={method}>{method}</option>)}</select><div className="mock-request-url"><span>{baseUrl}</span><input aria-label="Simulation path" value={draft.path} onChange={(event) => setValue("path", event.target.value)} /></div><button type="button" className="primary-button mock-send-button" onClick={() => onRun(scenario)}><Play size={16} /> Send</button></div>
    {!simpleGet && !databaseGet && <div className="mock-simulation-inputs"><label>Request headers<textarea value={draft.requestHeaders} onChange={(event) => setValue("requestHeaders", event.target.value)} spellCheck="false" /></label>{isBodyMethod && <label>Request body<textarea value={draft.requestBody} onChange={(event) => setValue("requestBody", event.target.value)} spellCheck="false" /></label>}{!isDatabase && <label>Scenario<select value={scenario} onChange={(event) => setScenario(event.target.value)}><option value="success">Success response</option><option value="error">Error response</option></select></label>}</div>}
    <div className="mock-response-heading"><div><span className="section-kicker"><span className="kicker-line" /> Response</span><h3>{response ? "Latest response" : "Run the request"}</h3></div>{response && <span className="mock-response-live">Local simulation</span>}</div><ResponsePanel response={response} />
    <div className="mock-postman-actions"><button type="button" className="secondary-button" onClick={() => setWorkspaceTab("create")}><FileText size={16} /> Back to Create API</button><button type="button" className="primary-button" onClick={onSave}><FileDown size={16} /> Save API to Local agent</button><button type="button" className="secondary-button" onClick={() => onCopy(mockFetchExample(project.id, { method: draft.method, pathname: draft.path, body: draft.requestBody, headers: exampleHeaders }))}><Copy size={15} /> Copy fetch</button><button type="button" className="secondary-button" onClick={() => onCopy(mockCurlExample(project.id, { method: draft.method, pathname: draft.path, body: draft.requestBody, headers: exampleHeaders }))}><Copy size={15} /> Copy cURL</button></div>
  </>}</div></section>;
}

export function MockApiPage() {
  const [project, setProject] = useState(initialProject);
  const [draft, setDraft] = useState(() => emptyDraft(initialProject()));
  const [surface, setSurface] = useState("builder");
  const [response, setResponse] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [curlText, setCurlText] = useState("");
  const [localProjects, setLocalProjects] = useState([]);
  const [agentStatus, setAgentStatus] = useState(null);
  const [storageReady, setStorageReady] = useState(false);
  const fileInput = useRef(null);

  const isDatabase = project.mode === "database";
  const collections = projectCollections(project);
  const endpoints = projectEndpoints(project);
  const savedEndpoint = endpoints.find((item) => item.id === draft.endpointId);
  const exampleHeaders = savedEndpoint?.request?.headers || {};
  const savedUrl = savedEndpoint ? localMockApiUrl(project.id, savedEndpoint.path) : localMockApiUrl(project.id, draft.path);

  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(DRAFT_STORAGE_KEY) || "null");
      if (stored?.project) {
        const restored = normalizeMockProject(stored.project);
        setProject(restored);
        setDraft(stored.draft && typeof stored.draft === "object" ? { ...emptyDraft(restored), ...stored.draft } : endpointDraft(restored));
        if (["builder", "local", "history", "guide"].includes(stored.surface)) setSurface(stored.surface);
      }
    } catch { /* A corrupt browser draft should never block the workspace. */ }
    setStorageReady(true);
  }, []);
  useEffect(() => {
    if (!storageReady) return;
    try { window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ project, draft, surface })); } catch { /* Storage is optional; Local-agent saving remains available. */ }
  }, [draft, project, surface, storageReady]);
  useEffect(() => { if (surface === "local" || surface === "history") probeLocalAgent().then(setAgentStatus).catch((cause) => setAgentStatus({ connected: false, error: cause.message })); }, [surface]);
  useEffect(() => { if (surface === "history") listLocalMockProjects().then((items) => setLocalProjects(Array.isArray(items) ? items : [])).catch((cause) => setError(cause.message)); }, [surface]);

  const projectWithDraft = () => {
    const databaseCollection = isDatabase ? (draft.endpointId ? draft.collection || collectionFromPath(draft.path) : collectionFromPath(draft.path)) : "";
    const requestHeaders = parseJsonText(draft.requestHeaders, "Request headers", {});
    const requestBody = parseJsonText(draft.requestBody, "Request body", null);
    const successBody = parseJsonText(draft.successBody, "Success response", {});
    const errorBody = parseJsonText(draft.errorBody, "Error response", { error: "Mock API error" });
    const endpoint = { id: draft.endpointId || endpointId(draft.method, draft.path), name: draft.name || `${draft.method} ${draft.path}`, mode: project.mode, method: draft.method, path: draft.path, collection: isDatabase ? databaseCollection : undefined, request: { headers: requestHeaders, body: requestBody }, responses: { success: { status: Number(draft.successStatus) || 200, headers: parseJsonText(draft.successHeaders, "Success headers", {}), body: successBody, override: isDatabase ? draft.successOverride : true }, error: { status: Number(draft.errorStatus) || 400, headers: parseJsonText(draft.errorHeaders, "Error headers", {}), body: errorBody } } };
    let nextCollections = collections;
    if (isDatabase) {
      const existing = nextCollections.find((item) => item.name === databaseCollection);
      const records = draft.method === "GET" ? parseJsonText(draft.seedText, `${databaseCollection} JSON config`, []) : existing?.records || [];
      if (!Array.isArray(records) || records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) throw new MockApiError("JSON config must be an array of objects. Each object becomes one record in the shared dummy database.");
      const methods = [...new Set([...(existing?.methods || []), draft.method])];
      if (draft.method !== "GET" && !existing) throw new MockApiError(`Create a GET API with JSON data for /${databaseCollection} before adding ${draft.method}.`);
      nextCollections = existing ? nextCollections.map((item) => item.name === databaseCollection ? { ...item, methods, records } : item) : [...nextCollections, { name: databaseCollection, methods: [draft.method], records }];
    } else nextCollections = [];
    const nextEndpoints = endpoints.some((item) => item.id === endpoint.id) ? endpoints.map((item) => item.id === endpoint.id ? endpoint : item) : [...endpoints, endpoint];
    return normalizeMockProject({ ...project, collections: nextCollections, endpoints: nextEndpoints });
  };

  const setDraftValue = (value) => setDraft(value);
  const runRequest = (scenario = "success") => {
    try {
      const next = projectWithDraft();
      const body = parseJsonText(draft.requestBody, "Request body", undefined);
      const headers = parseJsonText(draft.requestHeaders, "Request headers", {});
      if (scenario === "error") headers["X-Mock-Scenario"] = "error";
      const result = simulateMockRequest(next, { method: draft.method, pathname: draft.path, body, headers });
      setResponse(result); setProject(result.project); setError("");
      if (isDatabase) { const collection = draft.endpointId ? draft.collection || collectionFromPath(draft.path) : collectionFromPath(draft.path); const records = projectCollections(result.project).find((item) => item.name === collection)?.records || []; setDraft((current) => ({ ...current, collection, seedText: pretty(records) })); }
      pushAnalyticsEvent("mock_api_request_simulated", { surface: "request_console", mode: "local", method: draft.method });
    } catch (cause) { setError(cause.message); setResponse({ status: cause.status || 400, headers: cause.headers || {}, body: { error: cause.message, code: cause.code || "mock_api_error" } }); }
  };
  const saveProject = async () => {
    try {
      const next = projectWithDraft();
      const saved = normalizeMockProject(await saveLocalMockProject(next));
      const savedId = draft.endpointId || endpointId(draft.method, draft.path);
      setProject(saved); setDraft(endpointDraft(saved, savedId)); setSurface("builder"); setError(""); setNotice("API saved. The Local agent is serving this project while authorization is active.");
      pushAnalyticsEvent("mock_api_local_host_started", { surface: "workspace", mode: "local" });
    } catch (cause) { setError(cause.message); }
  };
  const newApi = () => { setDraft(emptyDraft(project)); setResponse(null); setError(""); setNotice(""); setSurface("builder"); };
  const loadProject = (value) => { const next = normalizeMockProject(value); setProject(next); setDraft(endpointDraft(next)); setResponse(null); setError(""); setSurface("builder"); };
  const duplicateProject = (value) => loadProject({ ...value, id: undefined, name: `${value.name} copy` });
  const resetWorkspaceProject = () => { const next = initialProject(); setProject(next); setDraft(emptyDraft(next)); setResponse(null); setError(""); setNotice("The deleted project was removed from the workspace."); };
  const deleteProject = async (id) => { try { await deleteLocalMockProject(id); setLocalProjects((current) => current.filter((entry) => entry.id !== id)); if (project.id === id) resetWorkspaceProject(); pushAnalyticsEvent("mock_api_project_deleted", { surface: "history", mode: "local" }); } catch (cause) { setError(cause.message); } };
  const selectEndpoint = (id) => { setDraft(endpointDraft(project, id)); setResponse(null); setError(""); };
  const deleteEndpoint = (id) => { setProject((current) => ({ ...current, endpoints: projectEndpoints(current).filter((item) => item.id !== id) })); if (draft.endpointId === id) newApi(); };
  const clearDraft = () => { setDraft(emptyDraft(project)); setResponse(null); setError(""); setNotice("Current unsaved request cleared."); };
  const exportCurrent = () => { try { downloadText(`${project.id}.json`, exportMockProject(projectWithDraft())); } catch (cause) { setError(cause.message); } };
  const importFile = async (event) => { const file = event.target.files?.[0]; if (!file) return; try { loadProject(importMockProject(await file.text())); setNotice("Project imported. Save it to the Local agent to host the APIs."); } catch (cause) { setError(cause.message); } event.target.value = ""; };
  const copy = async (value) => { await navigator.clipboard?.writeText(value); setNotice("Copied to clipboard."); };
  const importCurl = () => { try { const parsed = parseMockCurl(curlText); setDraft((current) => ({ ...current, method: parsed.method, path: parsed.path, requestHeaders: pretty(parsed.headers), requestBody: parsed.bodyText })); setNotice(parsed.redacted ? "cURL imported. Sensitive header values were redacted." : "cURL imported into the request builder."); setError(""); } catch (cause) { setError(cause.message); } };

  return <AppShell><article className="mock-api-page">
    <header className="mock-api-hero"><div className="section-kicker"><span className="kicker-line" /> Build a local API</div><h1>Mock API for frontend testing</h1><p>Use a familiar request workspace to configure, send, inspect, and save JSON APIs while your real backend is still being built.</p><MockDiagram /><div className="mock-api-summary"><strong>Postman-style request testing.</strong> The Local agent stores and serves your APIs on this laptop through a callable localhost URL.</div></header>
    <nav className="mock-api-tabs" aria-label="Mock API workspace"><button type="button" className={surface === "builder" ? "active" : ""} onClick={() => setSurface("builder")}>API workspace</button><button type="button" className={surface === "local" ? "active" : ""} onClick={() => setSurface("local")}>Local agent</button><button type="button" className={surface === "history" ? "active" : ""} onClick={() => setSurface("history")}>Mock API History</button><button type="button" className={surface === "guide" ? "active" : ""} onClick={() => setSurface("guide")}>Helpful guide</button></nav>
    {error && <div className="mock-api-alert error" role="alert">{error}</div>}{notice && <div className="mock-api-alert success" role="status">{notice}</div>}
    {surface === "builder" && <PostmanWorkbench project={project} draft={draft} endpoints={endpoints} isDatabase={isDatabase} response={response} savedUrl={savedUrl} exampleHeaders={exampleHeaders} curlText={curlText} onDraftChange={setDraftValue} onNewApi={newApi} onSelectEndpoint={selectEndpoint} onRun={runRequest} onSave={saveProject} onImportCurl={importCurl} onCurlChange={setCurlText} onCopy={copy} onExport={exportCurrent} onImport={importFile} onClearDraft={clearDraft} fileInput={fileInput} onProjectChange={(name) => setProject((current) => ({ ...current, name }))} onProjectIdChange={(id) => setProject((current) => ({ ...current, id }))} />}
    {surface === "local" && <section className="mock-api-workspace" aria-labelledby="mock-local-title"><SectionHeading id="mock-local-title">Host with Local agent</SectionHeading><div className={`mock-agent-status ${agentStatus?.connected ? "connected" : ""}`}><span className="status-pulse" /><div><strong>{agentStatus?.connected ? "Local agent authorized" : "Local agent not ready"}</strong><p>{agentStatus?.connected ? "Projects are stored in Results/mock-apis and served from 127.0.0.1." : "Authorize the Local agent, then return here to save a project."}</p></div><Link className="secondary-button" href="/local-agent">Check connection</Link></div><div className="mock-api-actions"><button type="button" className="primary-button" onClick={() => setSurface("builder")}><Play size={16} /> Open workspace</button><button type="button" className="secondary-button" onClick={exportCurrent}><Download size={16} /> Export current project</button></div><div className="mock-api-code"><h3>Local base URL</h3><code>{localMockApiUrl(project.id)}</code><button type="button" className="icon-button" onClick={() => copy(localMockApiUrl(project.id))} title="Copy base URL"><Copy size={16} /></button></div><p className="mock-api-note">The agent binds only to <code>127.0.0.1</code> by default. It does not use Tailscale to expose mock APIs and can keep serving while the website is closed while authorization remains active.</p></section>}
    {surface === "history" && <section className="mock-api-workspace" aria-labelledby="mock-history-title"><SectionHeading id="mock-history-title">Mock API History</SectionHeading>{!agentStatus?.connected && <p className="mock-api-note">Connect and authorize the Local agent to view projects saved in its Results folder.</p>}<div className="mock-history-list">{localProjects.length ? localProjects.map((item) => <article className="mock-history-item" key={item.id}><div><strong>{item.name}</strong><small>{item.id} · {item.mode === "stateless" ? "No database" : `${projectCollections(item).length} collection${projectCollections(item).length === 1 ? "" : "s"}`} · {projectEndpoints(item).length} API{projectEndpoints(item).length === 1 ? "" : "s"}</small></div><div className="mock-history-actions"><button type="button" onClick={() => loadProject(item)}>Edit</button><button type="button" onClick={() => duplicateProject(item)}>Duplicate</button><button type="button" onClick={() => downloadText(`${item.id}.json`, exportMockProject(item))}>Export</button><button type="button" onClick={() => copy(localMockApiUrl(item.id))}>Copy URL</button><button type="button" className="danger" onClick={() => deleteProject(item.id)}>Delete</button></div></article>) : <p className="mock-api-note">No saved Mock API projects yet. Open the workspace and save your first API.</p>}</div></section>}
    {surface === "guide" && <section className="mock-api-guide" aria-labelledby="mock-guide-title"><SectionHeading id="mock-guide-title">A practical mock API for development</SectionHeading><p>Use the request workspace like a lightweight Postman collection: configure one endpoint, send a local request, inspect the response, then save it to the Local agent.</p><div className="mock-guide-table-wrap"><table><thead><tr><th>Need</th><th>Local agent</th></tr></thead><tbody><tr><th>External frontend can call it</th><td>Yes, from a local app via 127.0.0.1</td></tr><tr><th>Storage</th><td>Results/mock-apis on the connected computer</td></tr><tr><th>Data options</th><td>JSON records or fixed responses</td></tr><tr><th>Methods</th><td>GET, POST, PUT, PATCH, DELETE, OPTIONS</td></tr><tr><th>Network exposure</th><td>Loopback only; Tailscale is not used for Mock API hosting</td></tr></tbody></table></div><h3>How to test errors</h3><p>Configure a fixed error response, or send <code>X-Mock-Scenario: error</code>. No user-authored JavaScript executes.</p><div className="mock-api-faq"><h3>Frequently asked questions</h3><details open><summary>Does Mock API create a callable URL?</summary><p>Yes. Save the project to the authorized Local agent, then use its 127.0.0.1 URL from apps on this laptop.</p></details><details><summary>Can Local agent serve APIs when the website closes?</summary><p>Yes. Once saved and authorized, the agent serves localhost requests independently until authorization expires or is revoked.</p></details><details><summary>Does Mock API use Tailscale?</summary><p>No. Mock APIs bind to 127.0.0.1 only. They are not exposed through Tailscale or to the local network by default.</p></details><details><summary>Can I import a cURL request?</summary><p>Yes. cURL is parsed locally and never executed. Sensitive authorization, cookie, token, and API-key values are redacted.</p></details></div></section>}
  </article></AppShell>;
}
