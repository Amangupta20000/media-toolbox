import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPair } from "node:crypto";

const keyDirectory = path.join(os.homedir(), ".config", "media-toolbox");
const defaultPrivateKeyPath = path.join(keyDirectory, "agent-runtime-update-private.pem");
const defaultPublicKeyPath = path.join(keyDirectory, "agent-runtime-update-public.pem");

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function createPair() {
  return new Promise((resolve, reject) => {
    generateKeyPair("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }, (error, publicKey, privateKey) => error ? reject(error) : resolve({ publicKey, privateKey }));
  });
}

const privateKeyPath = path.resolve(argument("--private-key", process.env.AGENT_RUNTIME_UPDATE_PRIVATE_KEY_FILE || defaultPrivateKeyPath));
const publicKeyPath = path.resolve(argument("--public-key", process.env.AGENT_RUNTIME_UPDATE_PUBLIC_KEY_FILE || defaultPublicKeyPath));

try {
  await fs.access(privateKeyPath);
  await fs.access(publicKeyPath);
  console.log(`Runtime update key pair already exists.\nPrivate key: ${privateKeyPath}\nPublic key:  ${publicKeyPath}`);
} catch {
  const pair = await createPair();
  await fs.mkdir(path.dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(privateKeyPath, pair.privateKey, { mode: 0o600 });
  await fs.writeFile(publicKeyPath, pair.publicKey, { mode: 0o644 });
  console.log(`Generated the runtime update key pair.\nPrivate key: ${privateKeyPath}\nPublic key:  ${publicKeyPath}\n\nKeep the private key outside the repository. Add the public key to the AGENT_RUNTIME_UPDATE_PUBLIC_KEY GitHub variable and the private key to the AGENT_RUNTIME_UPDATE_PRIVATE_KEY GitHub secret.`);
}
