import fs from "node:fs/promises";
import path from "node:path";

const value = String(process.env.AGENT_LICENSE_SERVER_URL || "").trim().replace(/\/$/, "");
if (value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("The URL must use HTTP or HTTPS.");
  } catch (error) {
    throw new Error(`AGENT_LICENSE_SERVER_URL is invalid: ${error.message}`);
  }
}
await fs.writeFile(path.join(process.cwd(), "agent", "license-server-url.txt"), `${value}\n`, { mode: 0o644 });
console.log(value ? "Embedded the licensing server URL in the agent." : "No licensing server URL configured; the agent will use offline activation mode.");
