import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";

const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 2_500;
const MAX_UPSTREAM_ATTEMPTS = 3;

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

function licensingServerUrl() {
  return String(process.env.NEXT_PUBLIC_LICENSE_SERVER_URL || "").trim().replace(/\/$/, "");
}

function requestedPath(request) {
  const parts = Array.isArray(request.query?.path) ? request.query.path : [request.query?.path];
  const value = parts.filter(Boolean).map((part) => String(part)).join("/");
  if (!/^v1\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(value) || value.includes("..")) return "";
  return `/${value}`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) return reject(Object.assign(new Error("The licensing request is too large."), { statusCode: 413 }));
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function json(response, status, payload) {
  response.status(status).setHeader("Cache-Control", "no-store").json(payload);
}

async function publicIpv4Addresses(target) {
  if (target.protocol !== "https:") return [];
  try {
    return [...new Set((await dns.resolve4(target.hostname)).map((value) => String(value).trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function requestWithAddress(target, options, address) {
  if (!address) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    return fetch(target, { ...options, signal: controller.signal })
      .then(async (upstream) => ({ status: upstream.status, contentType: upstream.headers.get("content-type"), body: Buffer.from(await upstream.arrayBuffer()) }))
      .finally(() => clearTimeout(timeout));
  }

  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const headers = { ...options.headers, Host: target.host };
    const request = transport.request({
      hostname: address,
      port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers,
      servername: target.protocol === "https:" ? target.hostname : undefined,
      timeout: REQUEST_TIMEOUT_MS,
    }, (upstream) => {
      const chunks = [];
      upstream.on("data", (chunk) => chunks.push(chunk));
      upstream.once("end", () => resolve({
        status: upstream.statusCode || 502,
        contentType: upstream.headers["content-type"] || "",
        body: Buffer.concat(chunks),
      }));
      upstream.once("error", reject);
    });
    request.once("timeout", () => request.destroy(new Error("The licensing server request timed out.")));
    request.once("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

export default async function handler(request, response) {
  const baseUrl = licensingServerUrl();
  const pathname = requestedPath(request);
  if (!baseUrl) return json(response, 503, { error: "The licensing server is not configured for this website." });
  if (!pathname) return json(response, 404, { error: "Licensing route not found." });

  let target;
  try {
    target = new URL(`${baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(request.query || {})) {
      if (key === "path") continue;
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) if (item !== undefined) target.searchParams.append(key, String(item));
    }
  } catch {
    return json(response, 500, { error: "The licensing server URL is invalid." });
  }

  const headers = {};
  for (const name of ["accept", "authorization", "content-type", "origin", "user-agent", "x-request-token"]) {
    const value = request.headers[name];
    if (value) headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  let body;
  let upstream;
  let lastError;
  try {
    body = ["GET", "HEAD"].includes(request.method) ? undefined : await readBody(request);
    const addresses = await publicIpv4Addresses(target);
    const candidates = [...addresses, null].slice(0, MAX_UPSTREAM_ATTEMPTS);
    for (const address of candidates) {
      try {
        upstream = await requestWithAddress(target, {
          method: request.method,
          headers,
          body,
          redirect: "error",
        }, address);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!upstream) throw lastError || new Error("The licensing server request failed.");
    response.status(upstream.status);
    response.setHeader("Cache-Control", "no-store");
    const contentType = upstream.contentType;
    if (contentType) response.setHeader("Content-Type", contentType);
    return response.send(upstream.body);
  } catch (error) {
    error = lastError || error;
    if (error?.statusCode) return json(response, error.statusCode, { error: error.message });
    if (error?.name === "AbortError") return json(response, 504, { error: "The licensing server request timed out." });
    return json(response, 502, { error: `The licensing server could not be reached: ${error?.message || "request failed"}` });
  }
}
