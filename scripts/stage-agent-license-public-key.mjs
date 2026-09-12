import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(projectDirectory, "agent", "license-public-key.pem");
const configured = String(process.env.AGENT_LICENSE_PUBLIC_KEY || "").trim();
const sourcePath = String(process.env.AGENT_LICENSE_PUBLIC_KEY_FILE || "").trim();

let publicKey = configured;
if (!publicKey && sourcePath) publicKey = await fs.readFile(path.resolve(sourcePath), "utf8");
if (!publicKey) {
  try { publicKey = await fs.readFile(destination, "utf8"); } catch { /* CI will report the missing owner key below */ }
}
if (!publicKey.includes("BEGIN PUBLIC KEY")) throw new Error("Set AGENT_LICENSE_PUBLIC_KEY (a PEM public key) before packaging the agent.");
await fs.writeFile(destination, `${publicKey.trim()}\n`, { mode: 0o644 });
console.log(`Embedded the license public key at ${destination}`);
