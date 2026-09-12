import http from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { activationDurationOptions, createSignedLicenseToken, isAllowedActivationDuration, licenseCodeHash, verifyLicenseToken, ACTIVATION_DURATION_MS } from "../lib/license-token.js";
import { licenseConfig } from "./config.js";
import { createLicenseStore } from "./store.js";
import { loadPrivateKey, publicKeyFor, encryptText, decryptText } from "./secrets.js";
import { updateAgentLicenseServerVariable } from "./github.js";

const WINDOW_MS = 60 * 60 * 1000;

function clientIp(request) {
  return String(request.headers["cf-connecting-ip"] || request.socket.remoteAddress || "unknown");
}

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function publicRequest(row, includeCode = false, code = null) {
  return {
    id: row.id,
    origin: row.origin,
    requesterLabel: row.requester_label,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    durationMs: row.duration_ms,
    redeemedAt: row.redeemed_at,
    redeemedDeviceId: row.redeemed_device_id,
    ...(includeCode && code ? { code } : {}),
  };
}

function readJson(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > limit) return reject(new Error("The request is too large."));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("The request body is not valid JSON.")); }
    });
    request.on("error", reject);
  });
}

function json(response, status, payload, origin = "") {
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

function errorStatus(error) {
  if (/not found/i.test(error.message)) return 404;
  if (/already|expired|invalid|incorrect|only pending|no longer active/i.test(error.message)) return 409;
  return 400;
}

function adminPasswordMatches(password, service) {
  let saltText = service.store.getSetting("admin_password_salt");
  let expectedText = service.store.getSetting("admin_password_hash");
  if (!saltText || !expectedText) {
    saltText = randomBytes(16).toString("base64");
    expectedText = scryptSync(service.config.adminPassword, Buffer.from(saltText, "base64"), 64, { N: 16_384, r: 8, p: 1 }).toString("base64");
    service.store.setSetting("admin_password_salt", saltText);
    service.store.setSetting("admin_password_hash", expectedText);
  }
  const expected = Buffer.from(expectedText, "base64");
  const actual = scryptSync(String(password || ""), Buffer.from(saltText, "base64"), 64, { N: 16_384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

export class LicenseService {
  constructor({ config = licenseConfig, store, privateKey = null, now = () => Date.now() } = {}) {
    this.config = config;
    this.store = store;
    this.privateKey = privateKey;
    this.now = now;
    this.rate = new Map();
  }

  async signingKey() {
    if (!this.privateKey) this.privateKey = await loadPrivateKey(this.config.dataDir);
    return this.privateKey;
  }

  allowedOrigin(request, required = false) {
    const requestOrigin = String(request.headers.origin || "").trim();
    if (!requestOrigin) return "";
    if (!this.config.publicOrigins.includes(requestOrigin)) throw new Error("This website origin is not trusted by the licensing server.");
    return requestOrigin;
  }

  checkRate(key, limit) {
    const now = this.now();
    const values = (this.rate.get(key) || []).filter((value) => value > now - WINDOW_MS);
    if (values.length >= limit) throw new Error("Too many requests. Try again later.");
    values.push(now);
    this.rate.set(key, values);
  }

  adminToken(request) {
    const value = String(request.headers.authorization || "");
    return /^Bearer\s+/i.test(value) ? value.replace(/^Bearer\s+/i, "").trim() : "";
  }

  requireAdmin(request) {
    const raw = this.adminToken(request);
    if (!raw || !this.store.getAdminSession(raw, this.now())) throw new Error("Admin authentication is required.");
    return raw;
  }

  async requestLicense(request, body) {
    this.store.cleanup(this.now());
    const origin = normalizeOrigin(body.origin || request.headers.origin);
    if (!origin || !this.config.publicOrigins.includes(origin)) throw new Error("A trusted website origin is required.");
    if (request.headers.origin && request.headers.origin !== origin) throw new Error("The request origin does not match the browser origin.");
    this.checkRate(`request:${clientIp(request)}`, 10);
    const requesterLabel = String(body.requesterLabel || "Website user").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "Website user";
    const durationMs = body.durationMs === undefined ? ACTIVATION_DURATION_MS : Number(body.durationMs);
    if (!isAllowedActivationDuration(durationMs)) throw new Error(`Choose one of the supported activation durations: ${activationDurationOptions().map(({ label }) => label).join(", ")}.`);
    const now = this.now();
    const created = this.store.createRequest({ origin, requesterLabel, durationMs, now, expiresAt: now + this.config.requestTtlMs });
    return { requestId: created.id, requestToken: created.requestToken, status: "pending", createdAt: now, expiresAt: now + this.config.requestTtlMs };
  }

  async requestStatus(request, id, token) {
    if (!token) throw new Error("A request token is required.");
    this.store.cleanup(this.now());
    const row = this.store.getRequestForToken(id, token);
    if (!row) throw new Error("License request not found or token is invalid.");
    if (row.status === "pending" && row.expires_at <= this.now()) {
      this.store.cleanup(this.now());
      row.status = "expired";
    }
    let code = null;
    if (row.status === "approved" && row.code_ciphertext) {
      // The code is encrypted with the service master key, not the signing key.
      // Loading through the helper keeps the encryption boundary in one module.
      const encrypted = { ciphertext: row.code_ciphertext, iv: row.code_iv, tag: row.code_tag };
      code = decryptText("", encrypted);
    }
    return publicRequest(row, Boolean(code), code);
  }

  async approve(request, id) {
    this.requireAdmin(request);
    const row = this.store.getRequest(id);
    if (!row) throw new Error("License request not found.");
    const privateKey = await this.signingKey();
    const licenseId = randomUUID();
    const payload = { v: 1, licenseId, origins: [row.origin], issuedAt: this.now(), durationMs: row.duration_ms };
    const code = createSignedLicenseToken(payload, privateKey);
    const encryptedCode = encryptText(code);
    this.store.approve(id, { licenseId, codeHash: licenseCodeHash(code), encryptedCode, now: this.now() });
    return publicRequest(this.store.getRequest(id));
  }

  decline(request, id, body) {
    this.requireAdmin(request);
    const reason = String(body.reason || "Declined by owner").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
    return publicRequest(this.store.decline(id, { reason, now: this.now() }));
  }

  async redeem(request, body) {
    this.checkRate(`redeem:${clientIp(request)}`, 30);
    const deviceId = String(body.deviceId || "").trim();
    const code = String(body.code || "").trim();
    if (!deviceId || deviceId.length > 200 || !code) throw new Error("A device ID and activation code are required.");
    const privateKey = await this.signingKey();
    const publicKey = publicKeyFor(privateKey);
    const payload = verifyLicenseToken(code, publicKey);
    if (payload.v !== 1 || typeof payload.licenseId !== "string" || !isAllowedActivationDuration(payload.durationMs) || !Array.isArray(payload.origins) || payload.deviceId) throw new Error("The activation code format is invalid.");
    const origin = normalizeOrigin(body.origin || request.headers.origin || payload.origins[0]);
    if (!origin || !payload.origins.includes(origin)) throw new Error("This activation code is not valid for this website origin.");
    if (payload.issuedAt && Number(payload.issuedAt) > this.now() + 5 * 60 * 1000) throw new Error("This activation code is not valid yet.");
    const codeHash = licenseCodeHash(code);
    this.store.consume({ licenseId: payload.licenseId, codeHash, deviceId, origin, now: this.now() });
    const boundPayload = { ...payload, deviceId, boundAt: this.now() };
    const token = createSignedLicenseToken(boundPayload, privateKey);
    return { ok: true, token, licenseId: payload.licenseId, deviceId, origin, expiresAt: this.now() + Number(payload.durationMs) };
  }

  async handle(request, response) {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    const origin = (() => { try { return this.allowedOrigin(request); } catch { return ""; } })();
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-Token");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Max-Age", "600");
    if (request.method === "OPTIONS") return json(response, origin ? 204 : (request.headers.origin ? 403 : 204), {}, origin);
    if (request.headers.origin && !origin) return json(response, 403, { error: "This website origin is not trusted by the licensing server." });
    try {
      if (url.pathname === "/v1/health" && request.method === "GET") return json(response, 200, { ok: true, service: "media-toolbox-license-server", protocolVersion: 1 }, origin);
      if (url.pathname === "/v1/license-requests" && request.method === "POST") return json(response, 201, await this.requestLicense(request, await readJson(request, this.config.maxBodyBytes)), origin);
      const requestMatch = url.pathname.match(/^\/v1\/license-requests\/([^/]+)$/);
      if (requestMatch && request.method === "GET") return json(response, 200, await this.requestStatus(request, decodeURIComponent(requestMatch[1]), String(request.headers["x-request-token"] || url.searchParams.get("token") || "")), origin);
      if (url.pathname === "/v1/licenses/redeem" && request.method === "POST") return json(response, 200, await this.redeem(request, await readJson(request, this.config.maxBodyBytes)), origin);
      if (url.pathname === "/v1/admin/login" && request.method === "POST") {
        this.checkRate(`login:${clientIp(request)}`, 20);
        const body = await readJson(request, this.config.maxBodyBytes);
        if (String(body.username || "") !== this.config.adminUsername || !adminPasswordMatches(body.password, this)) throw new Error("The Admin username or password is incorrect.");
        const now = this.now();
        return json(response, 200, { ok: true, ...this.store.createAdminSession({ now, expiresAt: now + this.config.adminSessionTtlMs }) }, origin);
      }
      if (url.pathname === "/v1/admin/logout" && request.method === "POST") {
        this.store.deleteAdminSession(this.requireAdmin(request));
        return json(response, 200, { ok: true }, origin);
      }
      if (url.pathname === "/v1/admin/license-requests" && request.method === "GET") {
        this.requireAdmin(request);
        this.store.cleanup(this.now());
        return json(response, 200, { items: this.store.listRequests().map((row) => publicRequest(row)) }, origin);
      }
      if (url.pathname === "/v1/admin/github/agent-license-server-url" && request.method === "POST") {
        this.requireAdmin(request);
        this.checkRate(`github-variable:${clientIp(request)}`, 10);
        const body = await readJson(request, this.config.maxBodyBytes);
        return json(response, 200, await updateAgentLicenseServerVariable({ url: body.url, config: this.config }), origin);
      }
      const adminMatch = url.pathname.match(/^\/v1\/admin\/license-requests\/([^/]+)\/(approve|decline)$/);
      if (adminMatch && request.method === "POST") {
        const body = await readJson(request, this.config.maxBodyBytes);
        const result = adminMatch[2] === "approve" ? await this.approve(request, decodeURIComponent(adminMatch[1])) : this.decline(request, decodeURIComponent(adminMatch[1]), body);
        return json(response, 200, result, origin);
      }
      return json(response, 404, { error: "Licensing route not found." }, origin);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The licensing request failed.";
      const status = error.statusCode || (/authentication is required|incorrect/i.test(message) ? 401 : /too many/i.test(message) ? 429 : errorStatus(error));
      return json(response, status, { error: message }, origin);
    }
  }
}

let active;

export async function createLicenseServer(options = {}) {
  const service = options.service || new LicenseService({ config: options.config || licenseConfig, store: options.store || await createLicenseStore(options.dataDir || (options.config || licenseConfig).dataDir), privateKey: options.privateKey, now: options.now });
  const server = http.createServer((request, response) => service.handle(request, response).catch((error) => json(response, 500, { error: error.message || "The licensing server could not complete the request." })));
  const cleanupIntervalMs = Number(options.cleanupIntervalMs ?? service.config.licenseRequestCleanupIntervalMs ?? 60 * 1000);
  if (cleanupIntervalMs > 0) {
    const cleanup = () => {
      try { service.store.cleanup(service.now()); } catch (error) { console.error("Media Toolbox licensing request cleanup failed:", error); }
    };
    cleanup();
    const cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
    cleanupTimer.unref?.();
    server.once("close", () => clearInterval(cleanupTimer));
  }
  server.service = service;
  return server;
}

export async function startLicenseServer(options = {}) {
  if (active) return active;
  const config = options.config || licenseConfig;
  const host = options.host ?? config.host;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("The licensing server must listen only on the local loopback interface.");
  const server = await createLicenseServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? config.port, host, resolve);
  });
  active = server;
  const address = server.address();
  console.log(`Media Toolbox licensing server listening on http://${host}:${address.port}`);
  return server;
}

export async function stopLicenseServer() {
  if (!active) return;
  const server = active;
  active = null;
  await new Promise((resolve) => server.close(resolve));
  server.service?.store?.close?.();
}
