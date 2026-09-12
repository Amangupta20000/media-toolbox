import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { licenseConfig } from "../license-server/config.js";
import { ensureLicenseStorage } from "../license-server/storage.js";
import { bootstrapEncryptedPrivateKey, publicKeyFor } from "../license-server/secrets.js";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

const outputDirectory = path.join(os.homedir(), ".config", "media-toolbox");
const privatePath = path.resolve(arg("--private-key", process.env.LICENSE_PRIVATE_KEY_FILE || path.join(outputDirectory, "agent-license-private.pem")));
const publicPath = path.resolve(arg("--public-key", process.env.LICENSE_PUBLIC_KEY_FILE || path.join(outputDirectory, "agent-license-public.pem")));
const dataDir = await ensureLicenseStorage(licenseConfig.dataDir);
let privateKey;
try {
  privateKey = await fs.readFile(privatePath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  privateKey = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
}
const publicKey = publicKeyFor(privateKey).export({ type: "spki", format: "pem" });
await fs.mkdir(path.dirname(publicPath), { recursive: true, mode: 0o700 });
await fs.writeFile(publicPath, publicKey, { mode: 0o644 });
await bootstrapEncryptedPrivateKey(privateKey, dataDir);
console.log(`Licensing signing key is encrypted at: ${path.join(dataDir, "signing-key.enc.json")}`);
console.log(`Public key for the Local Agent: ${publicPath}`);
console.log("Keep the public key in AGENT_LICENSE_PUBLIC_KEY for agent packaging. Never commit the private key.");
