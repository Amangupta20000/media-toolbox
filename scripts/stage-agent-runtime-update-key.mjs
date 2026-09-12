import fs from "node:fs/promises";
import path from "node:path";

const destination = path.join(process.cwd(), "agent", "runtime-update-public-key.pem");
const configured = String(process.env.AGENT_RUNTIME_UPDATE_PUBLIC_KEY || "").trim();
const sourcePath = String(process.env.AGENT_RUNTIME_UPDATE_PUBLIC_KEY_FILE || "").trim();
let publicKey = configured;
if (!publicKey && sourcePath) publicKey = await fs.readFile(path.resolve(sourcePath), "utf8");
if (!publicKey) {
  try { publicKey = await fs.readFile(destination, "utf8"); } catch { /* CI reports the missing key below. */ }
}
if (!publicKey.includes("BEGIN PUBLIC KEY")) throw new Error("Set AGENT_RUNTIME_UPDATE_PUBLIC_KEY (an Ed25519 PEM public key) before packaging the agent.");
await fs.writeFile(destination, `${publicKey.trim()}\n`, { mode: 0o644 });
console.log(`Embedded the runtime update public key at ${destination}`);
