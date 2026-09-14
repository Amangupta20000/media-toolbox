import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 4_500;
const MAX_UPSTREAM_ATTEMPTS = 2;

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

function resolveIpv4(hostname, lookupOptions, callback) {
  // Vercel's serverless DNS layer can return an undefined address through
  // dns.lookup for Tailscale Funnel hostnames. Resolve the public A record
  // explicitly first, then retain the normal lookup as a compatibility
  // fallback for other licensing hosts.
  const finish = (address, family = 4) => {
    // node:http requests DNS results with all:true. Returning a string for
    // that form makes Node read address.address from undefined and surface
    // the misleading `Invalid IP address: undefined` error.
    if (lookupOptions?.all) return callback(null, [{ address, family }]);
    return callback(null, address, family);
  };
  dns.resolve4(hostname, (error, addresses) => {
    const address = (addresses || []).find((value) => net.isIP(value) === 4);
    if (address) return finish(address, 4);
    dns.lookup(hostname, { ...lookupOptions, family: 4, all: false }, (lookupError, lookupAddress, family) => {
      if (!lookupError && lookupAddress && net.isIP(lookupAddress) === 4) return finish(lookupAddress, family || 4);
      callback(lookupError || error || new Error(`No IPv4 address was found for ${hostname}.`));
    });
  });
}

function json(response, status, payload) {
  response.status(status).setHeader("Cache-Control", "no-store").json(payload);
}

function requestOverIpv4(target, options) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const headers = { ...options.headers };
    if (options.body && !headers["content-length"] && !headers["Content-Length"]) {
      headers["content-length"] = String(options.body.length);
    }
    const request = transport.request({
      hostname: target.hostname,
      port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
      path: `${target.pathname}${target.search}`,
      method: options.method,
      headers,
      servername: target.protocol === "https:" ? target.hostname : undefined,
      lookup: resolveIpv4,
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
    request.once("timeout", () => {
      const error = new Error("The licensing server request timed out.");
      error.name = "AbortError";
      request.destroy(error);
    });
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
  for (const name of ["accept", "authorization", "content-type", "origin", "user-agent", "x-request-token", "x-media-toolbox-device-id", "x-media-toolbox-device-name", "x-media-toolbox-os"]) {
    const value = request.headers[name];
    if (value) headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  let body;
  let upstream;
  let lastError;
  try {
    body = ["GET", "HEAD"].includes(request.method) ? undefined : await readBody(request);
    for (let attempt = 0; attempt < MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
      try {
        upstream = await requestOverIpv4(target, {
          method: request.method,
          headers,
          body,
        });
        break;
      } catch (error) {
        lastError = error;
        if (attempt === MAX_UPSTREAM_ATTEMPTS - 1) throw error;
      }
    }
    if (!upstream) throw lastError || new Error("The licensing server request failed.");
    response.status(upstream.status);
    response.setHeader("Cache-Control", "no-store");
    if (upstream.contentType) response.setHeader("Content-Type", upstream.contentType);
    return response.send(upstream.body);
  } catch (error) {
    error = lastError || error;
    if (error?.statusCode) return json(response, error.statusCode, { error: error.message });
    if (error?.name === "AbortError") return json(response, 504, { error: "The licensing server request timed out." });
    return json(response, 502, { error: `The licensing server could not be reached: ${error?.message || "request failed"}` });
  }
}
