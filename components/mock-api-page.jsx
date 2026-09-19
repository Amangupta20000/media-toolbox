"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Copy, Download, FileDown, FileText, Play, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { MockApiError, MOCK_METHODS, normalizeMockProject, parseMockCurl } from "../lib/mock-api.js";
import { pushAnalyticsEvent } from "../lib/analytics.js";
import { agentBaseUrl, probeLocalAgent } from "./processing-client.js";
import { deleteLocalMockProject, exportMockProject, importMockProject, listLocalMockProjects, localMockApiUrl, mockCurlExample, mockFetchExample, saveLocalMockProject, simulateMockRequest } from "./mock-api-client.js";
import { AppShell } from "./app-shell.jsx";

const DRAFT_STORAGE_KEY = "native-media-agent:mock-api-workspace";
const DEFAULT_PROJECT = { name: "Frontend mock API", id: "frontend-mock", mode: "database", collections: [], endpoints: [] };

function initialProject() { return normalizeMockProject(DEFAULT_PROJECT); }
function nextProjectId(projects = []) { const used = new Set(projects.map((item) => item?.id).filter(Boolean)); const base = `mock-project-${Date.now().toString(36)}`; let candidate = base; let suffix = 2; while (used.has(candidate)) candidate = `${base}-${suffix++}`; return candidate; }
function pretty(value) { return JSON.stringify(value, null, 2); }
function removeEmptyJsonLines(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim();
}
function prettifyJsonText(value) {
  const normalized = removeEmptyJsonLines(value);
  return JSON.stringify(JSON.parse(normalized), null, 2).replace(/\n{2,}/g, "\n");
}
function jsonParseErrorMessage(value) {
  try {
    JSON.parse(value);
    return "";
  } catch (error) {
    const position = Number(String(error?.message || "").match(/position (\d+)/i)?.[1]);
    if (!Number.isInteger(position)) return "Enter valid JSON before prettifying.";
    const beforeError = String(value).slice(0, position);
    const line = beforeError.split("\n").length;
    const column = position - beforeError.lastIndexOf("\n");
    return `Fix JSON syntax near line ${line}, column ${column}.`;
  }
}
function downloadText(filename, value) { const blob = new Blob([value], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url); }
function endpointId(method, path) { const value = `${method}-${path}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); return (value || "api").startsWith("api") ? value || "api" : `api-${value || "endpoint"}`; }
function parseJsonText(text, label, fallback = null) { if (!String(text || "").trim()) return fallback; try { return JSON.parse(text); } catch { throw new MockApiError(`${label} must be valid JSON.`); } }
function projectCollections(project) { return Array.isArray(project?.collections) ? project.collections : []; }
function projectEndpoints(project) { return Array.isArray(project?.endpoints) ? project.endpoints : []; }
function collectionFromPath(path) { const firstSegment = String(path || "").split("?")[0].split("/").filter(Boolean)[0] || "users"; const safeName = firstSegment.replace(/[^a-zA-Z0-9_-]/g, ""); return safeName || "users"; }
function mockPathname(path) { const value = String(path || "/").trim(); const queryIndex = value.indexOf("?"); return (queryIndex < 0 ? value : value.slice(0, queryIndex)) || "/"; }
function collectionSeedValue(collection) { const records = Array.isArray(collection?.records) ? collection.records : []; return collection?.responseShape === "object" ? records[0] || {} : records; }
function collectionForDraft(endpoints, draft) { const boundGet = endpoints.find((item) => item.id === draft.databaseEndpointId && item.method === "GET"); const savedEndpoint = endpoints.find((item) => item.id === draft.endpointId); const matchingGet = endpoints.find((item) => item.method === "GET" && item.path === mockPathname(draft.path)); const firstGet = endpoints.find((item) => item.method === "GET"); const firstGetCollection = firstGet?.collection || (firstGet ? collectionFromPath(firstGet.path) : null); return boundGet?.collection || (boundGet ? collectionFromPath(boundGet.path) : null) || (draft.method !== "GET" ? firstGetCollection : null) || draft.collection || savedEndpoint?.collection || matchingGet?.collection || collectionFromPath(draft.path); }
function emptyDraft(project) { const collections = projectCollections(project); const collection = collections[0]?.name || "users"; const records = collections[0]?.records || []; const defaultPath = "/" + collection; const usedGetPaths = new Set(projectEndpoints(project).filter((item) => item.method === "GET").map((item) => item.path)); let path = defaultPath; let suffix = 2; while (usedGetPaths.has(path)) path = "/" + collection + "-" + suffix++; return { endpointId: "", databaseEndpointId: "", name: "", method: "GET", path, collection: collectionFromPath(path), responseNodeMode: "record", responseNodePath: "", requestHeaders: "{}", requestBody: "", successStatus: "200", successHeaders: '{\n  "Content-Type": "application/json"\n}', successBody: "{\n  \"message\": \"ok\"\n}", successOverride: false, errorStatus: "400", errorHeaders: '{\n  "Content-Type": "application/json"\n}', errorBody: '{\n  "error\": "Mock API error"\n}', seedText: pretty(path === defaultPath ? records : []) }; }
function endpointDraft(project, endpointIdValue) {
  const endpoint = projectEndpoints(project).find((item) => item.id === endpointIdValue) || projectEndpoints(project)[0];
  const collections = projectCollections(project);
  const collection = endpoint?.collection || collections[0]?.name || "users";
  const collectionEntry = collections.find((item) => item.name === collection);
  const records = collectionEntry?.records || [];
  const responseShape = endpoint?.responseShape === "object" || collectionEntry?.responseShape === "object" ? "object" : collectionEntry?.responseShape;
  const singleRecordResponse = collectionEntry?.singleRecordResponse || "auto";
  const getEndpoint = projectEndpoints(project).find((item) => item.method === "GET" && (item.collection || collectionFromPath(item.path)) === collection) || projectEndpoints(project).find((item) => item.method === "GET");
  return endpoint ? {
    endpointId: endpoint.id,
    databaseEndpointId: endpoint.method === "GET" ? endpoint.id : getEndpoint?.id || "",
    name: endpoint.name,
    method: endpoint.method,
    path: endpoint.path,
    collection,
    responseNodeMode: endpoint.responseNodePath ? "node" : "record",
    responseNodePath: endpoint.responseNodePath || "",
    singleRecordResponse,
    requestHeaders: pretty(endpoint.request?.headers || {}),
    requestBody: endpoint.request?.body ? pretty(endpoint.request.body) : "",
    successStatus: String(endpoint.responses?.success?.status || 200),
    successHeaders: pretty(endpoint.responses?.success?.headers || {}),
    successBody: pretty(endpoint.responses?.success?.body ?? {}),
    successOverride: Boolean(endpoint.responses?.success?.override),
    errorStatus: String(endpoint.responses?.error?.status || 400),
    errorHeaders: pretty(endpoint.responses?.error?.headers || {}),
    errorBody: pretty(endpoint.responses?.error?.body ?? { error: "Mock API error" }),
    seedText: pretty(responseShape === "object" ? records[0] || {} : collectionSeedValue(collectionEntry)),
  } : emptyDraft(project);
}
function projectWithoutEndpoint(projectInput, endpointIdValue) {
  const project = normalizeMockProject(projectInput);
  const endpoint = project.endpoints.find((item) => item.id === endpointIdValue);
  if (!endpoint) return { project, endpoint: null };
  const remainingEndpoints = project.endpoints.filter((item) => item.id !== endpointIdValue);
  const collections = project.mode === "database" && endpoint.collection
    ? project.collections
        .filter((item) => item.name !== endpoint.collection || remainingEndpoints.some((entry) => entry.collection === item.name))
        .map((item) => {
          if (item.name !== endpoint.collection) return item;
          const methods = [...new Set(remainingEndpoints.filter((entry) => entry.collection === item.name).map((entry) => entry.method))];
          return { ...item, methods };
        })
    : project.collections;
  return { project: normalizeMockProject({ ...project, collections, endpoints: remainingEndpoints }), endpoint };
}

function MockDiagram() { return <svg className="mock-api-diagram" viewBox="0 0 860 190" role="img" aria-labelledby="mock-api-diagram-title mock-api-diagram-description"><title id="mock-api-diagram-title">Postman-style local mock API workflow</title><desc id="mock-api-diagram-description">Configure a request, run it, inspect the response, and save a callable Local-agent URL.</desc><defs><linearGradient id="mock-flow" x1="0" x2="1"><stop stopColor="#38d4cf" /><stop offset="1" stopColor="#81e6c4" /></linearGradient></defs><rect x="16" y="25" width="246" height="138" rx="18" className="mock-diagram-card" /><rect x="598" y="25" width="246" height="138" rx="18" className="mock-diagram-card" /><path d="M262 74h260c35 0 48-23 76-23" className="mock-diagram-line" /><path d="M262 118h260c35 0 48 23 76 23" className="mock-diagram-line" /><circle cx="342" cy="74" r="5" className="mock-diagram-dot" /><circle cx="462" cy="74" r="5" className="mock-diagram-dot" /><circle cx="398" cy="118" r="5" className="mock-diagram-dot" /><text x="40" y="62" className="mock-diagram-label">Build a request</text><text x="40" y="92" className="mock-diagram-copy">Send JSON locally</text><text x="40" y="119" className="mock-diagram-copy">Save when it works</text><text x="620" y="62" className="mock-diagram-label">Test and copy</text><text x="620" y="92" className="mock-diagram-copy">Inspect the response</text><text x="620" y="119" className="mock-diagram-copy">One project, many APIs</text></svg>; }
function SectionHeading({ id, children, detail }) { return <div className="mock-api-section-heading"><div><div className="section-kicker"><span className="kicker-line" /> Mock API beta</div><h2 id={id}>{children}</h2></div>{detail && <p>{detail}</p>}</div>; }
function ResponsePanel({ response }) {
  const [tab, setTab] = useState("body");
  if (!response) return <div className="mock-response-empty">Send a request to see the status, headers, and JSON response.</div>;
  return <div className="mock-response mock-postman-response"><div className="mock-response-status"><strong className={response.status >= 400 ? "error" : "success"}>{response.status}</strong><span>{response.status === 204 ? "No content" : "JSON response"}</span>{response.durationMs !== undefined && <small>{response.durationMs} ms</small>}</div><div className="mock-response-tabs"><button type="button" className={tab === "body" ? "active" : ""} onClick={() => setTab("body")}>Body</button><button type="button" className={tab === "headers" ? "active" : ""} onClick={() => setTab("headers")}>Headers</button></div>{tab === "body" ? <pre>{response.body == null ? "" : JSON.stringify(response.body, null, 2)}</pre> : <pre>{JSON.stringify(response.headers || {}, null, 2)}</pre>}</div>;
}

function jsonNestingDepth(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function countFoldItems(text, openIndex, closeIndex) {
  let depth = 0;
  let commas = 0;
  let hasValue = false;
  let inString = false;
  let escaped = false;
  for (let index = openIndex + 1; index < closeIndex; index += 1) {
    const character = text[index];
    if (inString) {
      hasValue = true;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; hasValue = true; }
    else if (character === "{" || character === "[") { depth += 1; hasValue = true; }
    else if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) commas += 1;
    else if (!/\s/.test(character)) hasValue = true;
  }
  return hasValue ? commas + 1 : 0;
}

function buildJsonFolds(text) {
  const stack = [];
  const folds = [];
  let line = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n") { line += 1; continue; }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') { inString = true; continue; }
    if (character === "{" || character === "[") stack.push({ index, line, character, depth: stack.length });
    else if ((character === "}" || character === "]") && stack.length) {
      const opening = stack.pop();
      const matching = (opening.character === "{" && character === "}") || (opening.character === "[" && character === "]");
      if (matching && opening.line < line) folds.push({ key: `${opening.line}:${opening.index}`, startLine: opening.line, endLine: line, open: opening.character, close: character, closeIndex: index, depth: opening.depth, items: countFoldItems(text, opening.index, index) });
    }
  }
  return folds.sort((left, right) => left.startLine - right.startLine || left.depth - right.depth);
}

function jsonFoldSignature(fold) { return `${fold.open}:${fold.close}:${fold.depth}`; }
function remapJsonFoldKeys(sourceFolds, targetFolds, activeKeys) {
  const source = Array.isArray(sourceFolds) ? sourceFolds : [];
  const target = Array.isArray(targetFolds) ? targetFolds : [];
  const sourceGroups = new Map();
  const targetGroups = new Map();
  source.forEach((fold) => { const signature = jsonFoldSignature(fold); if (!sourceGroups.has(signature)) sourceGroups.set(signature, []); sourceGroups.get(signature).push(fold); });
  target.forEach((fold) => { const signature = jsonFoldSignature(fold); if (!targetGroups.has(signature)) targetGroups.set(signature, []); targetGroups.get(signature).push(fold); });
  return new Set([...activeKeys].map((key) => {
    const fold = source.find((item) => item.key === key);
    if (!fold) return null;
    const signature = jsonFoldSignature(fold);
    const sourceIndex = sourceGroups.get(signature)?.indexOf(fold) ?? -1;
    return targetGroups.get(signature)?.[sourceIndex]?.key || null;
  }).filter(Boolean));
}

function escapeJsonHtml(value) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function highlightJsonLine(line) {
  let commentStart = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === "/" && line[index + 1] === "/") { commentStart = index; break; }
  }
  const code = commentStart >= 0 ? line.slice(0, commentStart) : line;
  const comment = commentStart >= 0 ? `<span class="json-token-comment">${escapeJsonHtml(line.slice(commentStart))}</span>` : "";
  const tokenPattern = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:]/g;
  let output = "";
  let lastIndex = 0;
  let match;
  while ((match = tokenPattern.exec(code))) {
    output += escapeJsonHtml(code.slice(lastIndex, match.index));
    const token = match[0];
    const className = token.startsWith('"') ? (/^\s*:/.test(code.slice(match.index + token.length)) ? "json-token-key" : "json-token-string") : (/^-?\d/.test(token) ? "json-token-number" : (/^(true|false)$/.test(token) ? "json-token-boolean" : (token === "null" ? "json-token-null" : "json-token-punctuation")));
    output += `<span class="${className}">${escapeJsonHtml(token)}</span>`;
    lastIndex = match.index + token.length;
  }
  return output + escapeJsonHtml(code.slice(lastIndex)) + comment;
}

function pastedJsonText(rawText, { propertySlot = false, indent = "" } = {}) {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  if (propertySlot && !trimmed.startsWith("{") && !trimmed.startsWith("[") && trimmed.includes(":")) {
    try {
      const fragment = JSON.parse(`{${trimmed}}`);
      const lines = JSON.stringify(fragment, null, 2).split("\n").slice(1, -1).map((line, index) => {
        const relativeLine = line.startsWith("  ") ? line.slice(2) : line;
        return index === 0 ? relativeLine : indent + relativeLine;
      });
      return lines.join("\n");
    } catch { /* Try the normal value/object fragment shapes below. */ }
  }
  const candidates = [trimmed, `[${trimmed}]`, `{${trimmed}}`];
  for (const candidate of candidates) {
    try { return JSON.stringify(JSON.parse(candidate), null, 2); } catch { /* Try the next valid JSON fragment shape. */ }
  }
  return null;
}

function collapsedJsonLine(lines, fold) {
  const openingLine = lines[fold.startLine] || "";
  const closingLine = lines[fold.endLine] || "";
  const openingColumn = openingLine.indexOf(fold.open);
  const lineStart = lines.slice(0, fold.endLine).reduce((offset, line) => offset + line.length + 1, 0);
  const closingColumn = Math.max(0, fold.closeIndex - lineStart);
  const prefix = openingColumn >= 0 ? openingLine.slice(0, openingColumn) : openingLine;
  const suffix = closingLine.slice(closingColumn + 1);
  const countLabel = `${fold.items} ${fold.items === 1 ? "item" : "items"}`;
  return `${prefix}${fold.open}...${fold.close}${suffix} // ${countLabel}`;
}

function JsonBeautifierEditor({ label, value, onChange, helpText, placeholder }) {
  const editorRef = useRef(null);
  const highlightRef = useRef(null);
  const codeScrollRef = useRef(null);
  const pendingSelectionRef = useRef(null);
  const scrollRestoreRef = useRef(null);
  const lastValidFoldsRef = useRef([]);
  const [collapsedFolds, setCollapsedFolds] = useState(new Set());
  const [editorError, setEditorError] = useState("");
  const text = String(value ?? "");
  const lineHeight = 24;
  let isValid = false;
  try { if (text.trim()) JSON.parse(text); isValid = text.trim() !== ""; } catch { /* Keep incomplete JSON editable. */ }
  const parsedFolds = isValid ? buildJsonFolds(text) : [];
  useEffect(() => { if (isValid) lastValidFoldsRef.current = parsedFolds; }, [isValid, text]);
  const folds = isValid ? parsedFolds : lastValidFoldsRef.current;
  const foldByLine = new Map(folds.map((fold) => [fold.startLine, fold]));
  const collapsedFoldKeys = new Set([...collapsedFolds].filter((key) => folds.some((fold) => fold.key === key)));
  const isFoldedView = collapsedFoldKeys.size > 0;
  const hiddenLines = new Set();
  folds.forEach((fold) => { if (collapsedFoldKeys.has(fold.key)) for (let index = fold.startLine + 1; index <= fold.endLine; index += 1) hiddenLines.add(index); });
  const lines = text.split("\n");
  const collapsedFoldByLine = new Map(folds.filter((fold) => collapsedFoldKeys.has(fold.key)).map((fold) => [fold.startLine, fold]));
  const visibleLines = lines.map((lineText, index) => ({ lineText: collapsedFoldByLine.has(index) ? collapsedJsonLine(lines, collapsedFoldByLine.get(index)) : lineText, index })).filter(({ index }) => !hiddenLines.has(index));
  const editorHeight = Math.max(230, visibleLines.length * lineHeight + 80);
  useLayoutEffect(() => {
    if (!pendingSelectionRef.current || !editorRef.current) return;
    const selection = pendingSelectionRef.current;
    const valueLength = editorRef.current.value.length;
    const start = Math.min(selection.start, valueLength);
    const end = Math.min(selection.end, valueLength);
    editorRef.current.focus();
    editorRef.current.selectionStart = start;
    editorRef.current.selectionEnd = end;
    pendingSelectionRef.current = null;
  }, [text]);
  useLayoutEffect(() => {
    const snapshot = scrollRestoreRef.current;
    if (!snapshot) return;
    const restoreScroll = () => {
      window.scrollTo(snapshot.pageX, snapshot.pageY);
      if (codeScrollRef.current) {
        codeScrollRef.current.scrollTop = snapshot.containerTop;
        codeScrollRef.current.scrollLeft = snapshot.containerLeft;
      }
    };
    restoreScroll();
    requestAnimationFrame(() => {
      restoreScroll();
      if (scrollRestoreRef.current === snapshot) scrollRestoreRef.current = null;
    });
  }, [text]);
  const formatText = (nextText = text) => {
    const scrollContainer = codeScrollRef.current;
    scrollRestoreRef.current = {
      pageX: window.scrollX,
      pageY: window.scrollY,
      containerTop: scrollContainer?.scrollTop || 0,
      containerLeft: scrollContainer?.scrollLeft || 0,
    };
    try {
      const formattedText = prettifyJsonText(nextText);
      setCollapsedFolds(remapJsonFoldKeys(folds, buildJsonFolds(formattedText), collapsedFolds));
      onChange(formattedText);
      setEditorError("");
      return true;
    } catch {
      const cleanedText = removeEmptyJsonLines(nextText);
      if (cleanedText !== nextText) {
        onChange(cleanedText);
      }
      setEditorError(jsonParseErrorMessage(cleanedText));
      return false;
    }
  };
  const preserveCollapsedFolds = (nextText) => {
    try {
      JSON.parse(nextText);
      setCollapsedFolds(remapJsonFoldKeys(folds, buildJsonFolds(nextText), collapsedFolds));
    } catch { /* Keep the current folds while the user is between valid JSON states. */ }
  };
  const replaceSelection = (nextText, caretPosition) => { pendingSelectionRef.current = { start: caretPosition, end: caretPosition }; preserveCollapsedFolds(nextText); onChange(nextText); setEditorError(""); };
  const handleChange = (event) => {
    pendingSelectionRef.current = { start: event.target.selectionStart, end: event.target.selectionEnd };
    preserveCollapsedFolds(event.target.value);
    onChange(event.target.value);
    setEditorError("");
  };
  const handlePaste = (event) => {
    const pasted = event.clipboardData?.getData("text/plain") || "";
    const target = event.currentTarget;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const propertySlot = /(?:\{|,)\s*$/.test(before) && /^\s*(?:,|})/.test(after);
    const linePrefix = before.slice(before.lastIndexOf("\n") + 1).match(/^\s*/)?.[0] || "";
    const formattedPaste = pastedJsonText(pasted, { propertySlot, indent: linePrefix });
    if (!formattedPaste) return;
    event.preventDefault();
    const nextText = text.slice(0, start) + formattedPaste + text.slice(end);
    try { const formattedDocument = prettifyJsonText(nextText); replaceSelection(formattedDocument, formattedDocument.length); }
    catch { replaceSelection(nextText, start + formattedPaste.length); }
  };
  const handleKeyDown = (event) => {
    const target = event.currentTarget;
    if (event.key === "Tab") {
      event.preventDefault();
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const indent = "  ";
      if (event.shiftKey) {
        const lineStart = text.lastIndexOf("\n", start - 1) + 1;
        const removeCount = text.slice(lineStart, start).startsWith(indent) ? indent.length : 0;
        replaceSelection(text.slice(0, lineStart) + text.slice(lineStart + removeCount), Math.max(lineStart, start - removeCount));
      } else replaceSelection(text.slice(0, start) + indent + text.slice(end), start + indent.length);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const depth = jsonNestingDepth(text.slice(0, start));
    const indent = "  ".repeat(depth);
    replaceSelection(text.slice(0, start) + "\n" + indent + text.slice(end), start + 1 + indent.length);
  };
  const handleEditorMouseUp = (event) => {
    if (event.button !== 0 || event.detail !== 1 || event.shiftKey || isFoldedView || !editorRef.current || !highlightRef.current) return;
    if (editorRef.current.selectionStart !== editorRef.current.selectionEnd) return;
    const editor = editorRef.current;
    const highlight = highlightRef.current;
    const previousEditorPointerEvents = editor.style.pointerEvents;
    const previousHighlightPointerEvents = highlight.style.pointerEvents;
    editor.style.pointerEvents = "none";
    highlight.style.pointerEvents = "auto";
    const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    editor.style.pointerEvents = previousEditorPointerEvents;
    highlight.style.pointerEvents = previousHighlightPointerEvents;
    if (!caret || !highlight.contains(caret.offsetNode)) return;
    const line = caret.offsetNode.nodeType === Node.ELEMENT_NODE
      ? caret.offsetNode.closest(".json-beautifier-code-line")
      : caret.offsetNode.parentElement?.closest(".json-beautifier-code-line");
    if (!line) return;
    const lineIndex = Number(line.dataset.lineIndex);
    if (!Number.isInteger(lineIndex)) return;
    const lineRange = document.createRange();
    lineRange.setStart(line, 0);
    lineRange.setEnd(caret.offsetNode, caret.offset);
    const lineOffset = lineRange.toString().length;
    const documentOffset = lines.slice(0, lineIndex).reduce((offset, lineText) => offset + lineText.length + 1, 0) + lineOffset;
    editor.focus();
    editor.setSelectionRange(documentOffset, documentOffset);
  };
  const collapseToLevel = (level) => { editorRef.current?.blur(); pendingSelectionRef.current = null; setCollapsedFolds(new Set(folds.filter((fold) => fold.depth >= level).map((fold) => fold.key))); };
  const toggleFold = (fold) => { editorRef.current?.blur(); pendingSelectionRef.current = null; setCollapsedFolds((current) => { const next = new Set(current); if (next.has(fold.key)) next.delete(fold.key); else next.add(fold.key); return next; }); };
  const handleFoldedViewClick = (event) => {
    if (!isFoldedView || event.target.closest("button") || !editorRef.current || !highlightRef.current) return;
    const editor = editorRef.current;
    const highlight = highlightRef.current;
    const scrollContainer = event.currentTarget;
    const previousScrollTop = scrollContainer.scrollTop;
    const previousScrollLeft = scrollContainer.scrollLeft;
    const renderedLines = [...highlight.querySelectorAll(".json-beautifier-code-line")];
    const firstLine = renderedLines[0];
    if (!firstLine) return;
    const firstLineTop = firstLine.getBoundingClientRect().top;
    const clickedLine = event.target.closest?.(".json-beautifier-code-line");
    const fallbackLineIndex = Math.max(0, Math.min(renderedLines.length - 1, Math.floor((event.clientY - firstLineTop) / lineHeight)));
    const line = clickedLine || renderedLines[fallbackLineIndex];
    if (!line) return;
    const visibleLineIndex = renderedLines.indexOf(line);
    if (visibleLineIndex < 0) return;
    const lineIndex = Number(line.dataset.lineIndex);
    if (!Number.isInteger(lineIndex)) return;
    const collapsedFold = collapsedFoldByLine.get(lineIndex);
    const targetLineIndex = collapsedFold ? collapsedFold.startLine : lineIndex;
    const targetLine = lines[targetLineIndex] || "";
    const lineStart = lines.slice(0, targetLineIndex).reduce((offset, lineText) => offset + lineText.length + 1, 0);
    const lineText = line.textContent || "";
    const lineRange = document.createRange();
    lineRange.selectNodeContents(line);
    const lineRect = lineRange.getBoundingClientRect();
    const characterWidth = lineText ? lineRect.width / lineText.length : 0;
    const clickedOffset = characterWidth > 0 ? Math.round((event.clientX - lineRect.left) / characterWidth) : 0;
    const targetOffset = collapsedFold ? Math.max(0, targetLine.indexOf(collapsedFold.open)) : Math.max(0, Math.min(targetLine.length, clickedOffset));
    const documentOffset = lineStart + targetOffset;
    editor.focus();
    editor.setSelectionRange(documentOffset, documentOffset);
    const editorScrollTop = Math.max(0, (targetLineIndex - visibleLineIndex) * lineHeight);
    editor.scrollTop = editorScrollTop;
    scrollContainer.scrollTop = previousScrollTop;
    scrollContainer.scrollLeft = previousScrollLeft;
    requestAnimationFrame(() => {
      if (editor !== document.activeElement) return;
      editor.scrollTop = editorScrollTop;
      scrollContainer.scrollTop = previousScrollTop;
      scrollContainer.scrollLeft = previousScrollLeft;
    });
  };
  return <div className="json-beautifier-editor"><div className="json-beautifier-heading"><strong>{label}</strong></div><div className="json-beautifier-surface"><div className="json-beautifier-toolbar" aria-label={`${label} formatting controls`}><div className="json-beautifier-actions"><button type="button" onClick={() => formatText()}>Prettify</button><button type="button" title="Collapse to level 1" onClick={() => collapseToLevel(1)}>Level 1</button><button type="button" title="Collapse to level 2" onClick={() => collapseToLevel(2)}>Level 2</button><button type="button" title="Collapse to level 3" onClick={() => collapseToLevel(3)}>Level 3</button><button type="button" onClick={() => setCollapsedFolds(new Set())}>Expand</button></div></div><div ref={codeScrollRef} className="json-beautifier-code-scroll" style={{ maxHeight: "75vh" }} onClick={handleFoldedViewClick}><div className="json-beautifier-code-layer" style={{ height: `${editorHeight}px` }}><pre ref={highlightRef} className="json-beautifier-highlight" aria-hidden="true">{visibleLines.map(({ lineText, index }) => <span className="json-beautifier-code-line" data-line-index={index} key={index} dangerouslySetInnerHTML={{ __html: highlightJsonLine(lineText) || " " }} />)}</pre><div className="json-beautifier-gutter" aria-hidden="true">{visibleLines.map(({ index }) => { const fold = foldByLine.get(index); return <span className="json-beautifier-gutter-line" key={index}><span className="json-beautifier-line-number">{index + 1}</span>{fold ? <button type="button" aria-label={`${collapsedFoldKeys.has(fold.key) ? "Expand" : "Collapse"} JSON node on line ${index + 1}`} onClick={() => toggleFold(fold)}>{collapsedFoldKeys.has(fold.key) ? "▸" : "▾"}</button> : <span className="json-beautifier-fold-placeholder" />}</span>; })}</div><textarea ref={editorRef} className={`json-beautifier-textarea json-beautifier-code-input${isFoldedView ? " json-beautifier-code-input-folded" : ""}`} aria-label={`${label} JSON editor`} tabIndex={isFoldedView ? -1 : 0} value={text} onChange={handleChange} onKeyDown={handleKeyDown} onMouseUp={handleEditorMouseUp} onBlur={() => { if (text.trim()) formatText(); }} onPaste={handlePaste} spellCheck="false" placeholder={placeholder} /></div></div></div>{helpText && <small className="mock-field-help">{helpText}</small>}{editorError && <small className="json-beautifier-error" role="alert">{editorError}</small>}</div>;
}

function PostmanWorkbench(props) { return <SeparatedPostmanWorkbench {...props} />; }

function SimpleGetWorkbench({ project, draft, endpoints, response, savedUrl, exampleHeaders, curlText, onDraftChange, onNewApi, onSelectEndpoint, onRun, onSave, onImportCurl, onCurlChange, onCopy, onExport, onImport, onClearDraft, fileInput, onProjectChange, onProjectIdChange, agentBaseUrlValue }) {
  const [scenario, setScenario] = useState("success");
  const setValue = (key, value) => onDraftChange({ ...draft, [key]: value });
  const currentId = draft.endpointId;
  const savedEndpoint = endpoints.find((item) => item.id === currentId);
  const baseUrl = localMockApiUrl(project.id, "", agentBaseUrlValue).replace(/\/$/, "");
  return <section className="mock-postman-shell mock-simple-get-shell" aria-label="Simple GET API workspace">
    <aside className="mock-api-sidebar">
      <div className="mock-sidebar-heading"><div><span className="section-kicker"><span className="kicker-line" /> Project</span><h2>{project.name}</h2></div><button type="button" className="icon-button mock-new-api-button" title="Create a new API" aria-label="Create a new API" onClick={onNewApi}><Plus size={18} aria-hidden="true" /></button></div>
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

function MockWorkspaceSidebar({ project, draft, endpoints, currentId, onNewProject, onNewApi, onSelectDraft, onSelectEndpoint, onDeleteEndpoint, onClearDraft, onProjectChange, onProjectIdChange }) { const hasUnsavedDraft = !draft.endpointId; const draftName = draft.name || `${draft.method} ${draft.path}`; return <aside className="mock-api-sidebar"><div className="mock-sidebar-heading"><div><span className="section-kicker"><span className="kicker-line" /> Project</span><h2>{project.name}</h2></div><button type="button" className="icon-button mock-new-project-button" title="Create a new project" aria-label="Create a new project" onClick={onNewProject}><Plus size={18} aria-hidden="true" /></button></div><label className="mock-sidebar-field">Project name<input value={project.name} onChange={(event) => onProjectChange(event.target.value)} /></label><label className="mock-sidebar-field">Project ID<input value={project.id} onChange={(event) => onProjectIdChange(event.target.value)} /><small>Letters, numbers, hyphens, and underscores.</small></label><div className="mock-sidebar-divider" /><div className="mock-sidebar-list-heading"><strong>Saved APIs</strong><div className="mock-sidebar-list-actions"><span>{endpoints.length}</span><button type="button" className="icon-button mock-new-api-button" title="Create a new API" aria-label="Create a new API" onClick={onNewApi}><Plus size={16} aria-hidden="true" /></button></div></div><div className="mock-sidebar-list">{endpoints.map((endpoint) => <div className="mock-sidebar-endpoint-row" key={endpoint.id}><button type="button" className={`mock-sidebar-endpoint ${endpoint.id === currentId ? "active" : ""}`} onClick={() => onSelectEndpoint(endpoint.id)}><span className="mock-saved-method">{endpoint.method}</span><span><strong>{endpoint.name}</strong><small>{endpoint.path}</small></span></button><button type="button" className="mock-sidebar-endpoint-delete" title={`Delete ${endpoint.name}`} aria-label={`Delete ${endpoint.name}`} onClick={() => onDeleteEndpoint(endpoint.id)}><Trash2 size={15} aria-hidden="true" /></button></div>)}{hasUnsavedDraft && <div className="mock-sidebar-endpoint-row mock-sidebar-draft-row"><button type="button" className="mock-sidebar-endpoint active" onClick={onSelectDraft}><span className="mock-saved-method">{draft.method}</span><span><strong>{draftName}</strong><small>{draft.path} · Unsaved draft</small></span></button></div>}{!endpoints.length && !hasUnsavedDraft && <p className="mock-sidebar-empty">Your saved APIs will appear here.</p>}</div><button type="button" className="mock-sidebar-clear" onClick={onClearDraft}>Clear current draft</button></aside>; }

function SeparatedPostmanWorkbench({ project, draft, endpoints, isDatabase, response, savedUrl, exampleHeaders, curlText, workspaceTabRequest, agentBaseUrlValue, onDraftChange, onNewProject, onNewApi, onSelectDraft, onSelectEndpoint, onDeleteEndpoint, onRun, onSave, onImportCurl, onCurlChange, onCopy, onExport, onImport, onClearDraft, fileInput, onProjectChange, onProjectIdChange }) {
  const [workspaceTab, setWorkspaceTab] = useState("create");
  const [scenario, setScenario] = useState("success");
  useEffect(() => {
    if (workspaceTabRequest?.tab) setWorkspaceTab(workspaceTabRequest.tab);
  }, [workspaceTabRequest]);
  const setValue = (key, value) => {
    const nextDraft = { ...draft, [key]: value };
    if (key === "method" && value === "GET") nextDraft.databaseEndpointId = "";
    if (key === "method" && value !== "GET" && !draft.databaseEndpointId && databaseGetOptions[0]) {
      nextDraft.databaseEndpointId = databaseGetOptions[0].endpoint.id;
      nextDraft.collection = databaseGetOptions[0].collection;
    }
    onDraftChange(nextDraft);
  };
  const simpleGet = !isDatabase && draft.method === "GET";
  const databaseGet = isDatabase && draft.method === "GET";
  const isBodyMethod = !["GET", "DELETE"].includes(draft.method);
  const databaseGetOptions = endpoints.filter((item) => item.method === "GET").reduce((options, item) => {
    const collection = item.collection || collectionFromPath(item.path);
    if (!options.some((option) => option.collection === collection)) options.push({ collection, endpoint: item });
    return options;
  }, []);
  const selectedDatabase = draft.databaseEndpointId || databaseGetOptions[0]?.endpoint.id || "";
  const baseUrl = localMockApiUrl(project.id, "", agentBaseUrlValue).replace(/\/$/, "");
  const savedEndpoint = endpoints.find((item) => item.id === draft.endpointId);
  return <section className="mock-postman-shell" aria-label="Mock API workspace"><MockWorkspaceSidebar project={project} draft={draft} endpoints={endpoints} currentId={draft.endpointId} onNewProject={onNewProject} onNewApi={onNewApi} onSelectDraft={onSelectDraft} onSelectEndpoint={onSelectEndpoint} onDeleteEndpoint={onDeleteEndpoint} onClearDraft={onClearDraft} onProjectChange={onProjectChange} onProjectIdChange={onProjectIdChange} /><div className="mock-postman-main"><div className="mock-postman-toolbar"><div><span className="section-kicker"><span className="kicker-line" /> Workspace</span><h2>{workspaceTab === "create" ? "Create API" : "Simulate API"}</h2></div><div className="mock-draft-retained"><Check size={14} /> Draft retained in this browser</div></div><div className="mock-workspace-tabs" role="tablist" aria-label="API workspace tabs"><button type="button" role="tab" aria-selected={workspaceTab === "create"} className={workspaceTab === "create" ? "active" : ""} onClick={() => setWorkspaceTab("create")}>Create API</button><button type="button" role="tab" aria-selected={workspaceTab === "simulate"} className={workspaceTab === "simulate" ? "active" : ""} onClick={() => setWorkspaceTab("simulate")}>Simulate</button></div>{workspaceTab === "create" ? <>
    <div className="mock-pane-intro"><strong>{simpleGet ? "Simple GET endpoint" : databaseGet ? "Create your JSON database" : "Configure endpoint"}</strong><p>{simpleGet ? "Enter the JSON this route should return. Advanced response settings stay out of the way until you need them." : databaseGet ? "Add one JSON object or an array of objects. Saving this GET creates the shared database used by later POST, PUT, PATCH, and DELETE APIs." : "Define the request and response contract, then save this API to the Local agent."}</p></div>
    <div className="mock-request-bar"><select aria-label="Request method" value={draft.method} onChange={(event) => setValue("method", event.target.value)}>{MOCK_METHODS.map((method) => <option key={method}>{method}</option>)}</select><div className="mock-request-url"><span>{baseUrl}</span><input aria-label="API path" value={draft.path} onChange={(event) => setValue("path", event.target.value)} placeholder="/users" /></div><button type="button" className="secondary-button" onClick={() => setWorkspaceTab("simulate")}><Play size={16} /> Test</button></div>
    <div className="mock-request-meta"><label>API name<input value={draft.name} onChange={(event) => setValue("name", event.target.value)} placeholder={`${draft.method} ${draft.path}`} /></label><span className="mock-local-badge">Local agent · {isDatabase ? "dummy database" : "fixed response"}</span></div>
    {simpleGet || databaseGet ? <JsonBeautifierEditor label={databaseGet ? "JSON config" : "JSON response"} value={databaseGet ? draft.seedText : draft.successBody} onChange={(value) => setValue(databaseGet ? "seedText" : "successBody", value)} helpText={databaseGet ? <>Use one JSON object or an array of objects. Object input is returned as an object; array input is returned as an array. The route identifies the shared data, so later CRUD APIs can use the same records.</> : "Returned on success."} /> : <div className="mock-create-fields"><JsonBeautifierEditor label="Request headers" value={draft.requestHeaders} onChange={(value) => setValue("requestHeaders", value)} /><>{isBodyMethod && <JsonBeautifierEditor label="Request body (JSON)" value={draft.requestBody} onChange={(value) => setValue("requestBody", value)} placeholder={'{\n  "name": "New item"\n}'} />}</></div>}
    {databaseGet && <><div className="mock-db-use-note"><label><strong>Response data</strong><select aria-label="GET response data" value={draft.responseNodeMode || (draft.responseNodePath ? "node" : "record")} onChange={(event) => setValue("responseNodeMode", event.target.value)}><option value="record">Return the full matching record</option><option value="node">Return a specific node</option></select></label>{(draft.responseNodeMode === "node" || draft.responseNodePath) && <label><strong>Node path</strong><input aria-label="GET response node path" value={draft.responseNodePath || ""} onChange={(event) => setValue("responseNodePath", event.target.value)} placeholder="consentData.data" /></label>}<p>After query filters select records, return the complete record or a nested value using dot notation, such as <code>consentData</code> or <code>consentData.data</code>.</p></div><div className="mock-db-use-note"><label><strong>When one record matches</strong><select aria-label="Single-record response format" value={draft.singleRecordResponse || "auto"} onChange={(event) => setValue("singleRecordResponse", event.target.value)}><option value="auto">Use JSON config shape</option><option value="array">Return an array</option><option value="object">Return an object</option></select></label><p>Choose whether a single matching record is wrapped in an array or returned as one object.</p></div></>}
    {isDatabase && !databaseGet && <div className="mock-db-use-note"><label><strong>Use data from</strong><select aria-label="Database GET API" value={selectedDatabase} onChange={(event) => { const selected = databaseGetOptions.find(({ endpoint }) => endpoint.id === event.target.value); onDraftChange({ ...draft, databaseEndpointId: event.target.value, collection: selected?.collection || collectionFromPath(selected?.endpoint.path || draft.path) }); }}>{databaseGetOptions.length ? databaseGetOptions.map(({ collection, endpoint }) => <option key={endpoint.id} value={endpoint.id}>{endpoint.name || `GET ${endpoint.path}`} · {endpoint.path}</option>) : <option value="">Create a GET API first</option>}</select></label><p>This API reads and changes the records created by the selected GET API. Its route can be different.</p></div>}
    {!databaseGet && <details className="mock-request-options mock-simple-advanced" open={!simpleGet}><summary>{simpleGet ? "Advanced response options" : "Response configuration"}</summary><div className="mock-options-grid"><label>Success status<input value={draft.successStatus} onChange={(event) => setValue("successStatus", event.target.value)} inputMode="numeric" /></label><label>Error status<input value={draft.errorStatus} onChange={(event) => setValue("errorStatus", event.target.value)} inputMode="numeric" /></label><JsonBeautifierEditor label="Success headers" value={draft.successHeaders} onChange={(value) => setValue("successHeaders", value)} /><JsonBeautifierEditor label="Success response" value={draft.successBody} onChange={(value) => setValue("successBody", value)} /><JsonBeautifierEditor label="Error headers" value={draft.errorHeaders} onChange={(value) => setValue("errorHeaders", value)} /><JsonBeautifierEditor label="Error response" value={draft.errorBody} onChange={(value) => setValue("errorBody", value)} /></div></details>}
    <details className="mock-curl-import"><summary><FileText size={16} /> Import request from cURL</summary><div><textarea value={curlText} onChange={(event) => onCurlChange(event.target.value)} spellCheck="false" placeholder="Paste a cURL command here" /><button type="button" className="secondary-button" onClick={onImportCurl}><Upload size={16} /> Import request</button><small>Nothing is executed. Sensitive header values are redacted.</small></div></details>
    <div className="mock-postman-actions"><button type="button" className="primary-button" onClick={onSave}><FileDown size={16} /> Save API to Local agent</button><button type="button" className="secondary-button" onClick={onExport}><Download size={16} /> Export</button><button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}><Upload size={16} /> Import</button><input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={onImport} /></div>
  </> : <>
    <div className="mock-pane-intro"><strong>Send requests without changing the API definition</strong><p>{savedEndpoint ? `Testing ${savedEndpoint.name}.` : "Configure an API in the Create API tab, then send it here."}{databaseGet && " Add filters such as ?role=admin; combine different fields with &, or repeat a field for alternatives."}</p></div>
    <div className="mock-request-bar"><select aria-label="Simulation method" value={draft.method} onChange={(event) => setValue("method", event.target.value)}>{MOCK_METHODS.map((method) => <option key={method}>{method}</option>)}</select><div className="mock-request-url"><span>{baseUrl}</span><input aria-label="Simulation path" value={draft.path} onChange={(event) => setValue("path", event.target.value)} /></div><button type="button" className="primary-button mock-send-button" onClick={() => onRun(scenario)}><Play size={16} /> Send</button></div>
    {!simpleGet && !databaseGet && <div className="mock-simulation-inputs"><JsonBeautifierEditor label="Request headers" value={draft.requestHeaders} onChange={(value) => setValue("requestHeaders", value)} />{isBodyMethod && <JsonBeautifierEditor label="Request body" value={draft.requestBody} onChange={(value) => setValue("requestBody", value)} />}{!isDatabase && <label>Scenario<select value={scenario} onChange={(event) => setScenario(event.target.value)}><option value="success">Success response</option><option value="error">Error response</option></select></label>}</div>}
    <div className="mock-response-heading"><div><span className="section-kicker"><span className="kicker-line" /> Response</span><h3>{response ? "Latest response" : "Run the request"}</h3></div>{response && <span className="mock-response-live">Local simulation</span>}</div><ResponsePanel response={response} />
    <div className="mock-postman-actions"><button type="button" className="secondary-button" onClick={() => setWorkspaceTab("create")}><FileText size={16} /> Back to Create API</button><button type="button" className="primary-button" onClick={onSave}><FileDown size={16} /> Save API to Local agent</button><button type="button" className="secondary-button" onClick={() => onCopy(mockFetchExample(project.id, { method: draft.method, pathname: draft.path, body: draft.requestBody, headers: exampleHeaders }))}><Copy size={15} /> Copy fetch</button><button type="button" className="secondary-button" onClick={() => onCopy(mockCurlExample(project.id, { method: draft.method, pathname: draft.path, body: draft.requestBody, headers: exampleHeaders }))}><Copy size={15} /> Copy cURL</button></div>
  </>}</div></section>;
}

export function MockApiPage() {
  const [project, setProject] = useState(initialProject);
  const [draft, setDraft] = useState(() => emptyDraft(initialProject()));
  const [surface, setSurface] = useState("builder");
  const [workspaceTabRequest, setWorkspaceTabRequest] = useState(null);
  const [response, setResponse] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [curlText, setCurlText] = useState("");
  const [localProjects, setLocalProjects] = useState([]);
  const [agentStatus, setAgentStatus] = useState(null);
  // Resolve platform- and page-specific agent transport after hydration so
  // the first server and client render always contain the same URL.
  const [agentBaseUrlValue, setAgentBaseUrlValue] = useState("http://127.0.0.1:4789");
  const [storageReady, setStorageReady] = useState(false);
  const fileInput = useRef(null);

  const isDatabase = project.mode === "database";
  const collections = projectCollections(project);
  const endpoints = projectEndpoints(project);
  const savedEndpoint = endpoints.find((item) => item.id === draft.endpointId);
  const exampleHeaders = savedEndpoint?.request?.headers || {};
  const savedUrl = savedEndpoint ? localMockApiUrl(project.id, savedEndpoint.path, agentBaseUrlValue) : localMockApiUrl(project.id, draft.path, agentBaseUrlValue);

  useEffect(() => {
    setAgentBaseUrlValue(agentBaseUrl());
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

  const projectWithDraft = (baseProject = project, draftValue = draft) => {
    const baseCollections = projectCollections(baseProject);
    const baseEndpoints = projectEndpoints(baseProject);
    const databaseMode = baseProject.mode === "database";
    const requestPath = mockPathname(draftValue.path);
    const databaseCollection = databaseMode ? collectionForDraft(baseEndpoints, draftValue) : "";
    const existingCollection = databaseMode ? baseCollections.find((item) => item.name === databaseCollection) : null;
    const seedValue = databaseMode && draftValue.method === "GET" ? parseJsonText(draftValue.seedText, `${databaseCollection} JSON config`, []) : null;
    const responseShape = databaseMode
      ? draftValue.method === "GET"
        ? seedValue && typeof seedValue === "object" && !Array.isArray(seedValue) ? "object" : "array"
        : existingCollection?.responseShape || "array"
      : undefined;
    const configuredSingleRecordResponse = ["array", "object"].includes(draftValue.singleRecordResponse) ? draftValue.singleRecordResponse : existingCollection?.singleRecordResponse;
    const responseNodeMode = draftValue.responseNodeMode || (draftValue.responseNodePath ? "node" : "record");
    const responseNodePath = databaseMode && draftValue.method === "GET" && responseNodeMode === "node" ? String(draftValue.responseNodePath || "").trim() : undefined;
    if (databaseMode && draftValue.method === "GET" && responseNodeMode === "node" && !responseNodePath) throw new MockApiError("Enter a node path such as consentData or consentData.data.");
    const requestHeaders = parseJsonText(draftValue.requestHeaders, "Request headers", {});
    const requestBody = parseJsonText(draftValue.requestBody, "Request body", null);
    const successBody = parseJsonText(draftValue.successBody, "Success response", {});
    const errorBody = parseJsonText(draftValue.errorBody, "Error response", { error: "Mock API error" });
    const endpoint = { id: draftValue.endpointId || endpointId(draftValue.method, requestPath), name: draftValue.name || `${draftValue.method} ${requestPath}`, mode: baseProject.mode, method: draftValue.method, path: requestPath, collection: databaseMode ? databaseCollection : undefined, responseShape: databaseMode ? responseShape : undefined, responseNodePath, request: { headers: requestHeaders, body: requestBody }, responses: { success: { status: Number(draftValue.successStatus) || 200, headers: parseJsonText(draftValue.successHeaders, "Success headers", {}), body: successBody, override: databaseMode ? draftValue.successOverride : true }, error: { status: Number(draftValue.errorStatus) || 400, headers: parseJsonText(draftValue.errorHeaders, "Error headers", {}), body: errorBody } } };
    const routeConflict = baseEndpoints.find((item) => item.id !== draftValue.endpointId && item.method === endpoint.method && item.path === endpoint.path);
    if (routeConflict) throw new MockApiError(`An API for ${endpoint.method} ${endpoint.path} already exists. Select it from Saved APIs to edit it, or choose a different method or route.`);
    const idConflict = baseEndpoints.find((item) => item.id === endpoint.id && item.id !== draftValue.endpointId);
    if (idConflict) throw new MockApiError("This API route would reuse the ID of an existing API. Choose a different method or route.");
    let nextCollections = baseCollections;
    if (databaseMode) {
      const existing = existingCollection;
      const records = draftValue.method === "GET" ? (Array.isArray(seedValue) ? seedValue : [seedValue]) : existing?.records || [];
      if (!Array.isArray(records) || records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) throw new MockApiError("JSON config must be an object or an array of objects. Each object becomes one record in the shared dummy database.");
      const methods = [...new Set([...(existing?.methods || []), draftValue.method])];
      if (draftValue.method !== "GET" && !existing) throw new MockApiError(`Create a GET API with JSON data for /${databaseCollection} before adding ${draftValue.method}.`);
      nextCollections = existing ? nextCollections.map((item) => item.name === databaseCollection ? { ...item, methods, responseShape, singleRecordResponse: configuredSingleRecordResponse, records } : item) : [...nextCollections, { name: databaseCollection, methods: [draftValue.method], responseShape, singleRecordResponse: configuredSingleRecordResponse, records }];
    } else nextCollections = [];
    const nextEndpoints = baseEndpoints.some((item) => item.id === endpoint.id) ? baseEndpoints.map((item) => item.id === endpoint.id ? endpoint : item) : [...baseEndpoints, endpoint];
    return normalizeMockProject({ ...baseProject, collections: nextCollections, endpoints: nextEndpoints });
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
      if (isDatabase) { const collection = collectionForDraft(endpoints, draft); const collectionEntry = projectCollections(result.project).find((item) => item.name === collection); setDraft((current) => ({ ...current, collection, seedText: pretty(collectionSeedValue(collectionEntry)) })); }
      pushAnalyticsEvent("mock_api_request_simulated", { surface: "request_console", mode: "local", method: draft.method });
    } catch (cause) { setError(cause.message); setResponse({ status: cause.status || 400, headers: cause.headers || {}, body: { error: cause.message, code: cause.code || "mock_api_error" } }); }
  };
  const saveProject = async () => {
    try {
      let saveBaseProject = project;
      let saveDraft = draft;
      if (isDatabase) {
        const collectionName = collectionForDraft(endpoints, draft);
        const localCollection = collections.find((item) => item.name === collectionName);
        const draftSeedIsUnchanged = draft.method !== "GET" || draft.seedText === pretty(collectionSeedValue(localCollection));
        const latestProject = (await listLocalMockProjects()).find((item) => item.id === project.id);
        if (latestProject) {
          saveBaseProject = latestProject;
          if (draftSeedIsUnchanged && draft.method === "GET") {
            const latestCollection = projectCollections(latestProject).find((item) => item.name === collectionName);
            saveDraft = { ...draft, seedText: pretty(collectionSeedValue(latestCollection)) };
          }
        }
      }
      const next = projectWithDraft(saveBaseProject, saveDraft);
      const savedPayload = await saveLocalMockProject(next);
      // Older installed agents normalize unknown metadata away. Keep the shape
      // from the browser draft in the current workspace until that agent is updated.
      const saved = normalizeMockProject({
        ...savedPayload,
        collections: projectCollections(savedPayload).map((item) => {
          const source = projectCollections(next).find((entry) => entry.name === item.name);
          return source?.responseShape || source?.singleRecordResponse ? { ...item, responseShape: source.responseShape || item.responseShape, singleRecordResponse: source.singleRecordResponse || item.singleRecordResponse } : item;
        }),
        endpoints: projectEndpoints(savedPayload).map((item) => {
          const source = projectEndpoints(next).find((entry) => entry.id === item.id);
          return source?.responseShape || source?.responseNodePath ? { ...item, responseShape: source.responseShape || item.responseShape, responseNodePath: source.responseNodePath || item.responseNodePath } : item;
        }),
      });
      const savedId = draft.endpointId || endpointId(draft.method, mockPathname(draft.path));
      setProject(saved); setDraft(endpointDraft(saved, savedId)); setSurface("builder"); setError(""); setNotice("API saved. The Local agent is serving this project while authorization is active.");
      pushAnalyticsEvent("mock_api_local_host_started", { surface: "workspace", mode: "local" });
    } catch (cause) { setError(cause.message); }
  };
  const newApi = (showNotice = false) => { setDraft(emptyDraft(project)); setResponse(null); setError(""); setNotice(showNotice ? "New API draft ready." : ""); setSurface("builder"); };
  const newProject = () => { const next = normalizeMockProject({ name: "New mock API", id: nextProjectId([project, ...localProjects]), mode: "database", collections: [], endpoints: [] }); setProject(next); setDraft(emptyDraft(next)); setResponse(null); setError(""); setNotice("New project draft ready. Name it and save its first API when ready."); setSurface("builder"); };
  const openProjectEndpoint = (value, endpointIdValue, tab = "create") => { const next = normalizeMockProject(value); setProject(next); setDraft(endpointDraft(next, endpointIdValue)); setResponse(null); setError(""); setSurface("builder"); setWorkspaceTabRequest({ tab, token: Date.now() }); };
  const loadProject = (value) => openProjectEndpoint(value, projectEndpoints(value)[0]?.id, "create");
  const editHistoryEndpoint = (value, id) => openProjectEndpoint(value, id, "create");
  const simulateHistoryEndpoint = (value, id) => openProjectEndpoint(value, id, "simulate");
  const duplicateProject = (value) => loadProject({ ...value, id: undefined, name: `${value.name} copy` });
  const resetWorkspaceProject = () => { const next = initialProject(); setProject(next); setDraft(emptyDraft(next)); setResponse(null); setError(""); setNotice("The deleted project was removed from the workspace."); };
  const deleteProject = async (id) => { try { await deleteLocalMockProject(id); setLocalProjects((current) => current.filter((entry) => entry.id !== id)); if (project.id === id) resetWorkspaceProject(); pushAnalyticsEvent("mock_api_project_deleted", { surface: "history", mode: "local" }); } catch (cause) { setError(cause.message); } };
  const selectDraft = () => { setResponse(null); setError(""); setSurface("builder"); setWorkspaceTabRequest({ tab: "create", token: Date.now() }); };
  const selectEndpoint = (id) => { setDraft(endpointDraft(project, id)); setResponse(null); setError(""); };
  const deleteEndpoint = async (id) => {
    try {
      const removed = projectWithoutEndpoint(project, id);
      if (!removed.endpoint) return;
      const next = removed.project;
      const saved = normalizeMockProject(await saveLocalMockProject(next));
      setProject(saved);
      setLocalProjects((current) => current.map((item) => item.id === saved.id ? saved : item));
      if (draft.endpointId === id) setDraft(endpointDraft(saved));
      setResponse(null);
      setError("");
      setNotice(`${removed.endpoint.method} ${removed.endpoint.path} was deleted.`);
    } catch (cause) { setError(cause.message); }
  };
  const deleteHistoryEndpoint = async (value, id) => {
    try {
      const removed = projectWithoutEndpoint(value, id);
      if (!removed.endpoint) return;
      const saved = normalizeMockProject(await saveLocalMockProject(removed.project));
      setLocalProjects((current) => current.map((item) => item.id === saved.id ? saved : item));
      if (project.id === saved.id) {
        setProject(saved);
        if (draft.endpointId === id) setDraft(endpointDraft(saved));
        setResponse(null);
      }
      setError("");
      setNotice(`${removed.endpoint.method} ${removed.endpoint.path} was deleted.`);
    } catch (cause) { setError(cause.message); }
  };
  const clearDraft = () => { setDraft(emptyDraft(project)); setResponse(null); setError(""); setNotice("Current unsaved request cleared."); };
  const exportCurrent = () => { try { downloadText(`${project.id}.json`, exportMockProject(projectWithDraft())); } catch (cause) { setError(cause.message); } };
  const importFile = async (event) => { const file = event.target.files?.[0]; if (!file) return; try { loadProject(importMockProject(await file.text())); setNotice("Project imported. Save it to the Local agent to host the APIs."); } catch (cause) { setError(cause.message); } event.target.value = ""; };
  const copy = async (value) => { await navigator.clipboard?.writeText(value); setNotice("Copied to clipboard."); };
  const importCurl = () => { try { const parsed = parseMockCurl(curlText); setDraft((current) => ({ ...current, method: parsed.method, path: parsed.path, requestHeaders: pretty(parsed.headers), requestBody: parsed.bodyText })); setNotice(parsed.redacted ? "cURL imported. Sensitive header values were redacted." : "cURL imported into the request builder."); setError(""); } catch (cause) { setError(cause.message); } };

  return <AppShell><article className="mock-api-page">
    <header className="mock-api-hero"><div className="section-kicker"><span className="kicker-line" /> Build a local API</div><h1>Mock API for frontend testing</h1><p>Use a familiar request workspace to configure, send, inspect, and save JSON APIs while your real backend is still being built.</p><MockDiagram /><div className="mock-api-summary"><strong>Postman-style request testing.</strong> The Local agent stores and serves your APIs on this laptop through a callable localhost URL.</div></header>
    <nav className="mock-api-tabs" aria-label="Mock API workspace"><button type="button" className={surface === "builder" ? "active" : ""} onClick={() => setSurface("builder")}>API workspace</button><button type="button" className={surface === "local" ? "active" : ""} onClick={() => setSurface("local")}>Local agent</button><button type="button" className={surface === "history" ? "active" : ""} onClick={() => setSurface("history")}>Mock API History</button><button type="button" className={surface === "guide" ? "active" : ""} onClick={() => setSurface("guide")}>Helpful guide</button></nav>
    {error && <div className="mock-api-alert error" role="alert">{error}</div>}{notice && <div className="mock-api-alert success" role="status">{notice}</div>}
    {surface === "builder" && <PostmanWorkbench project={project} draft={draft} endpoints={endpoints} isDatabase={isDatabase} response={response} savedUrl={savedUrl} exampleHeaders={exampleHeaders} curlText={curlText} workspaceTabRequest={workspaceTabRequest} agentBaseUrlValue={agentBaseUrlValue} onDraftChange={setDraftValue} onNewProject={newProject} onNewApi={() => newApi(true)} onSelectDraft={selectDraft} onSelectEndpoint={selectEndpoint} onDeleteEndpoint={deleteEndpoint} onRun={runRequest} onSave={saveProject} onImportCurl={importCurl} onCurlChange={setCurlText} onCopy={copy} onExport={exportCurrent} onImport={importFile} onClearDraft={clearDraft} fileInput={fileInput} onProjectChange={(name) => setProject((current) => ({ ...current, name }))} onProjectIdChange={(id) => setProject((current) => ({ ...current, id }))} />}
    {surface === "local" && <section className="mock-api-workspace" aria-labelledby="mock-local-title"><SectionHeading id="mock-local-title">Host with Local agent</SectionHeading><div className={`mock-agent-status ${agentStatus?.connected ? "connected" : ""}`}><span className="status-pulse" /><div><strong>{agentStatus?.connected ? "Local agent authorized" : "Local agent not ready"}</strong><p>{agentStatus?.connected ? "Projects are stored in Results/mock-apis and served from 127.0.0.1." : "Authorize the Local agent, then return here to save a project."}</p></div><Link className="secondary-button" href="/local-agent">Check connection</Link></div><div className="mock-api-actions"><button type="button" className="primary-button" onClick={() => setSurface("builder")}><Play size={16} /> Open workspace</button><button type="button" className="secondary-button" onClick={exportCurrent}><Download size={16} /> Export current project</button></div><div className="mock-api-code"><h3>Local base URL</h3><code>{localMockApiUrl(project.id, "", agentBaseUrlValue)}</code><button type="button" className="icon-button" onClick={() => copy(localMockApiUrl(project.id, "", agentBaseUrlValue))} title="Copy base URL"><Copy size={16} /></button></div><p className="mock-api-note">The agent binds only to <code>127.0.0.1</code> by default. It does not use Tailscale to expose mock APIs and can keep serving while the website is closed while authorization remains active.</p></section>}
    {surface === "history" && <section className="mock-api-workspace" aria-labelledby="mock-history-title"><SectionHeading id="mock-history-title">Mock API History</SectionHeading>{!agentStatus?.connected && <p className="mock-api-note">Connect and authorize the Local agent to view projects saved in its Results folder.</p>}<div className="mock-history-list">{localProjects.length ? localProjects.map((item) => { const itemEndpoints = projectEndpoints(item); return <details className="mock-history-item" key={item.id}><summary className="mock-history-summary"><span><strong>{item.name}</strong><small>{item.id} · {item.mode === "stateless" ? "No database" : `${projectCollections(item).length} collection${projectCollections(item).length === 1 ? "" : "s"}`} · {itemEndpoints.length} API{itemEndpoints.length === 1 ? "" : "s"}</small></span><span className="mock-history-summary-count">{itemEndpoints.length} saved API{itemEndpoints.length === 1 ? "" : "s"}</span></summary><div className="mock-history-actions mock-history-project-actions"><button type="button" onClick={() => loadProject(item)}>Edit project</button><button type="button" onClick={() => duplicateProject(item)}>Duplicate</button><button type="button" onClick={() => downloadText(`${item.id}.json`, exportMockProject(item))}>Export</button><button type="button" onClick={() => copy(localMockApiUrl(item.id, "", agentBaseUrlValue))}>Copy base URL</button><button type="button" className="danger" onClick={() => deleteProject(item.id)}>Delete project</button></div><div className="mock-history-api-list">{itemEndpoints.length ? itemEndpoints.map((endpoint) => { const url = localMockApiUrl(item.id, endpoint.path, agentBaseUrlValue); return <div className="mock-history-api-item" key={endpoint.id}><div className="mock-history-api-details"><strong>{endpoint.name}</strong><small><code>{url}</code></small></div><div className="mock-history-actions"><button type="button" onClick={() => copy(url)}>Copy URL</button><button type="button" onClick={() => editHistoryEndpoint(item, endpoint.id)}>Edit</button><button type="button" onClick={() => simulateHistoryEndpoint(item, endpoint.id)}>Simulate</button><button type="button" className="danger" onClick={() => deleteHistoryEndpoint(item, endpoint.id)}>Delete</button></div></div>; }) : <p className="mock-api-note">No saved APIs in this project.</p>}</div></details>; }) : <p className="mock-api-note">No saved Mock API projects yet. Open the workspace and save your first API.</p>}</div></section>}
    {surface === "guide" && <section className="mock-api-guide" aria-labelledby="mock-guide-title"><SectionHeading id="mock-guide-title">A practical mock API for development</SectionHeading><p>Use the request workspace like a lightweight API workspace: configure one endpoint, send a local request, inspect the response, then save it to the Local agent.</p><div className="mock-guide-table-wrap"><table><thead><tr><th>Need</th><th>Local agent</th></tr></thead><tbody><tr><th>External frontend can call it</th><td>Yes, from a local app via 127.0.0.1</td></tr><tr><th>Storage</th><td>Results/mock-apis on the connected computer</td></tr><tr><th>Data options</th><td>JSON records or fixed responses</td></tr><tr><th>Methods</th><td>GET, POST, PUT, PATCH, DELETE, OPTIONS</td></tr><tr><th>Network exposure</th><td>Loopback only; Tailscale is not used for Mock API hosting</td></tr></tbody></table></div><h3>How to test errors</h3><p>Configure a fixed error response, or send <code>X-Mock-Scenario: error</code>. No user-authored JavaScript executes.</p><div className="mock-api-faq"><h3>Frequently asked questions</h3><details open><summary>Does Mock API create a callable URL?</summary><p>Yes. Save the project to the authorized Local agent, then use its 127.0.0.1 URL from apps on this laptop.</p></details><details><summary>Can Local agent serve APIs when the website closes?</summary><p>Yes. Once saved and authorized, the agent serves localhost requests independently until authorization expires or is revoked.</p></details><details><summary>Does Mock API use Tailscale?</summary><p>No. Mock APIs bind to 127.0.0.1 only. They are not exposed through Tailscale or to the local network by default.</p></details><details><summary>Can I import a cURL request?</summary><p>Yes. cURL is parsed locally and never executed. Sensitive authorization, cookie, token, and API-key values are redacted.</p></details></div></section>}
  </article></AppShell>;
}
