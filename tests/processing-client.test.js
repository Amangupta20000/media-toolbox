import assert from "node:assert/strict";
import test from "node:test";
import { agentBaseCandidates, probeLocalAgent } from "../components/processing-client.js";

test("local HTTP website falls back to the installed HTTPS loopback agent", () => {
  const candidates = agentBaseCandidates({
    secure: false,
    configured: "http://127.0.0.1:4789",
    remembered: "",
  });

  assert.deepEqual(candidates, [
    "http://127.0.0.1:4789",
    "https://127.0.0.1:4789",
    "http://localhost:4789",
    "https://localhost:4789",
  ]);
});

test("HTTPS website does not fall back to an HTTP agent endpoint", () => {
  const candidates = agentBaseCandidates({
    secure: true,
    configured: "https://127.0.0.1:4789",
    remembered: "",
  });

  assert.deepEqual(candidates, [
    "https://127.0.0.1:4789",
    "https://localhost:4789",
  ]);
});

test("secure Windows/Linux pages discover HTTP loopback while macOS stays HTTPS-only", () => {
  const originalWindow = globalThis.window;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.window = { location: { protocol: "https:", origin: "https://media-toolbox-woad.vercel.app" } };
  try {
    Object.defineProperty(globalThis, "navigator", { value: { platform: "Win32" }, configurable: true, writable: true });
    assert.deepEqual(agentBaseCandidates({ secure: true, configured: "http://127.0.0.1:4789", remembered: "" }), [
      "http://localhost:4789",
      "http://127.0.0.1:4789",
    ]);

    Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64" }, configurable: true, writable: true });
    assert.deepEqual(agentBaseCandidates({ secure: true, configured: "http://127.0.0.1:4789", remembered: "" }), [
      "http://localhost:4789",
      "http://127.0.0.1:4789",
    ]);

    Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel" }, configurable: true, writable: true });
    assert.deepEqual(agentBaseCandidates({ secure: true, configured: "https://127.0.0.1:4789", remembered: "" }), [
      "https://127.0.0.1:4789",
      "https://localhost:4789",
    ]);
  } finally {
    globalThis.window = originalWindow;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test("secure Windows pages discard a remembered HTTPS loopback endpoint", () => {
  const originalWindow = globalThis.window;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.window = { location: { protocol: "https:", origin: "https://media-toolbox-woad.vercel.app" } };
  try {
    Object.defineProperty(globalThis, "navigator", { value: { platform: "Win32" }, configurable: true, writable: true });
    assert.deepEqual(agentBaseCandidates({ secure: true, configured: "http://127.0.0.1:4789", remembered: "https://127.0.0.1:4789" }).slice(0, 2), [
      "http://localhost:4789",
      "http://127.0.0.1:4789",
    ]);
  } finally {
    globalThis.window = originalWindow;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test("secure Windows pages use HTTP when the browser only exposes a user agent", () => {
  const originalWindow = globalThis.window;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  globalThis.window = { location: { protocol: "https:", origin: "https://media-toolbox-woad.vercel.app" } };
  try {
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36" }, configurable: true, writable: true });
    assert.deepEqual(agentBaseCandidates({ secure: true, configured: "http://127.0.0.1:4789", remembered: "https://127.0.0.1:4789" }).slice(0, 2), [
      "http://localhost:4789",
      "http://127.0.0.1:4789",
    ]);
  } finally {
    globalThis.window = originalWindow;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test("an authorized localhost browser creates its session during discovery", async () => {
  const values = new Map();
  const calls = [];
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  globalThis.window = {
    location: { protocol: "http:", origin: "http://localhost:3000" },
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).startsWith("http://")) throw new TypeError("HTTP endpoint is not the installed agent");
    if (String(url).endsWith("/v1/health")) return { ok: true, json: async () => ({ processingAvailable: true, trialAvailable: false, trustedOrigin: true, authorization: { mode: "activation", authorized: true } }) };
    if (String(url).endsWith("/v1/session")) return { ok: true, json: async () => ({ token: "local-session-token", sessionId: "local-session", expiresAt: Date.now() + 60_000 }) };
    if (String(url).endsWith("/v1/capabilities")) return { ok: true, json: async () => ({ status: "ready" }) };
    throw new Error(`Unexpected test URL: ${url}`);
  };

  try {
    const value = await probeLocalAgent();
    assert.equal(value.connected, true);
    assert.equal(value.baseUrl, "https://127.0.0.1:4789");
    assert.equal(values.get("media-toolbox-agent-token"), "local-session-token");
    assert.ok(calls.some(({ url }) => url.endsWith("/v1/session")));
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
