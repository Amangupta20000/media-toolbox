function encodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signature(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export async function createSessionToken(username, password, secret) {
  const value = `${username}:${password}`;
  return `${encodeBytes(new TextEncoder().encode(value))}.${encodeBytes(await signature(value, secret))}`;
}

export async function verifySessionToken(token, username, password, secret) {
  try {
    const [encodedValue, encodedSignature] = token.split(".");
    if (!encodedValue || !encodedSignature) return false;
    const value = new TextDecoder().decode(decodeBytes(encodedValue));
    if (value !== `${username}:${password}`) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("HMAC", key, decodeBytes(encodedSignature), new TextEncoder().encode(value));
  } catch {
    return false;
  }
}

export function parseBasicAuth(value) {
  if (!value?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(value.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}
