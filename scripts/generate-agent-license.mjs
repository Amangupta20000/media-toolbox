import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPair as createKeyPair, randomUUID, sign } from "node:crypto";
import { activationDurationOptions } from "../lib/token.js";

const keyDirectory = path.join(os.homedir(), ".config", "media-toolbox");
const defaultPrivateKeyPath = path.join(keyDirectory, "agent-license-private.pem");
const defaultPublicKeyPath = path.join(keyDirectory, "agent-license-public.pem");
const durationOption = (value) => activationDurationOptions().find((option) => option.value === value);

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function has(name) {
  return process.argv.includes(name);
}

function withoutPadding(buffer) {
  return Buffer.from(buffer).toString("base64").replace(/=+$/g, "");
}

function grouped(value) {
  return value.match(/.{1,4}/g)?.join("-") || value;
}

function generateKeyPair() {
  return new Promise((resolve, reject) => {
    createKeyPair("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }, (error, publicKey, privateKey) => error ? reject(error) : resolve({ publicKey, privateKey }));
  });
}

async function keygen() {
  const privatePath = path.resolve(arg("--private-key", process.env.AGENT_LICENSE_PRIVATE_KEY_FILE || defaultPrivateKeyPath));
  const publicPath = path.resolve(arg("--public-key", process.env.AGENT_LICENSE_PUBLIC_KEY_FILE || defaultPublicKeyPath));
  try {
    await fs.access(privatePath);
    await fs.access(publicPath);
    console.log(`License key pair already exists.\nPrivate key: ${privatePath}\nPublic key:  ${publicPath}`);
    return;
  } catch { /* generate the first owner key pair */ }
  const pair = await generateKeyPair();
  await fs.mkdir(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(privatePath, pair.privateKey, { mode: 0o600 });
  await fs.writeFile(publicPath, pair.publicKey, { mode: 0o644 });
  console.log(`Generated the owner license key pair.\nPrivate key: ${privatePath}\nPublic key:  ${publicPath}\n\nEmbed the public key in the released agent (or set AGENT_LICENSE_PUBLIC_KEY_FILE for development). Never commit or upload the private key.`);
}

async function createLicense() {
  const duration = arg("--duration", "10m");
  const deviceId = arg("--device-id").trim();
  const origins = arg("--origins").split(",").map((value) => value.trim()).filter(Boolean);
  const privatePath = path.resolve(arg("--private-key", process.env.AGENT_LICENSE_PRIVATE_KEY_FILE || defaultPrivateKeyPath));
  const selectedDuration = durationOption(duration);
  if (!selectedDuration) throw new Error("Only --duration 10m, 30m, 2h, 6h, or 1d is supported.");
  if (!deviceId || !origins.length) throw new Error("Usage: npm run agent:license -- --device-id <device-id> --duration 10m|30m|2h|6h|1d --origins <origin1,origin2>");
  const privateKey = await fs.readFile(privatePath, "utf8");
  const payload = {
    v: 1,
    licenseId: randomUUID(),
    deviceId,
    origins,
    issuedAt: Date.now(),
    durationMs: selectedDuration.durationMs,
  };
  const payloadText = withoutPadding(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = withoutPadding(sign(null, Buffer.from(payloadText), privateKey));
  // Standard base64 is used inside the token so '-' remains an unambiguous
  // human-readable group separator.
  const token = `MT1-${grouped(`${payloadText}.${signature}`)}`;
  console.log(token);
}

try {
  if (has("--keygen")) await keygen();
  else await createLicense();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
