import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { licenseConfig } from "./config.js";

const KEY_LENGTH = 32;

function envMasterKey() {
  const value = String(process.env.LICENSE_MASTER_KEY || "").trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === KEY_LENGTH) return decoded;
  } catch { /* fall through */ }
  throw new Error("LICENSE_MASTER_KEY must be a 32-byte base64 or 64-character hex value.");
}
function keychainKey() {
  if (process.platform !== "darwin") return null;
  try {
    const value = execFileSync("/usr/bin/security", ["find-generic-password", "-s", licenseConfig.keychainService, "-a", licenseConfig.keychainAccount, "-w"], { encoding: "utf8", timeout: 5000 }).trim();
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === KEY_LENGTH) return decoded;
  } catch { /* create it below */ }
  const generated = randomBytes(KEY_LENGTH).toString("base64");
  try {
    execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-s", licenseConfig.keychainService, "-a", licenseConfig.keychainAccount, "-w", generated], { stdio: "ignore", timeout: 5000 });
    return Buffer.from(generated, "base64");
  } catch {
    return null;
  }
}

function protectedFileKey() {
  const configured = process.env.LICENSE_MASTER_KEY_FILE || path.join(os.homedir(), ".config", "media-toolbox", "license-server-master.key");
  try {
    const existing = fs.readFileSync(configured);
    if (existing.length === KEY_LENGTH) return existing;
  } catch { /* create below */ }
  const generated = randomBytes(KEY_LENGTH);
  fs.mkdirSync(path.dirname(configured), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configured, generated, { mode: 0o600 });
  return generated;
}

export function getMasterKey() {
  return envMasterKey() || keychainKey() || protectedFileKey();
}

export function encryptText(value, key = getMasterKey()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptText(value, encrypted, key = getMasterKey()) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export async function bootstrapEncryptedPrivateKey(privateKeyText, dataDir) {
  const encrypted = encryptText(privateKeyText);
  const target = path.join(dataDir, "signing-key.enc.json");
  await fsp.writeFile(target, JSON.stringify(encrypted), { mode: 0o600 });
  return target;
}

export async function loadPrivateKey(dataDir) {
  const encryptedPath = path.join(dataDir, "signing-key.enc.json");
  try {
    const encrypted = JSON.parse(await fsp.readFile(encryptedPath, "utf8"));
    return createPrivateKey(decryptText("", encrypted));
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`The encrypted licensing signing key could not be read: ${error.message}`);
  }
  const configuredPath = process.env.LICENSE_PRIVATE_KEY_FILE || path.join(os.homedir(), ".config", "media-toolbox", "agent-license-private.pem");
  try {
    const privateKeyText = await fsp.readFile(configuredPath, "utf8");
    await bootstrapEncryptedPrivateKey(privateKeyText, dataDir);
    return createPrivateKey(privateKeyText);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const envPrivate = String(process.env.LICENSE_PRIVATE_KEY || "").trim();
  if (envPrivate) {
    await bootstrapEncryptedPrivateKey(envPrivate, dataDir);
    return createPrivateKey(envPrivate);
  }
  throw new Error("No licensing signing key is configured. Run npm run license-server:keygen or set LICENSE_PRIVATE_KEY_FILE.");
}

export function publicKeyFor(privateKey) {
  return createPublicKey(privateKey);
}

export function fingerprintKey(publicKey) {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}
