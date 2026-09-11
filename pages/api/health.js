import fs from "node:fs/promises";
import { paths } from "../../lib/config.js";

export default async function handler(_request, response) {
  try {
    const capabilities = JSON.parse(await fs.readFile(paths.capabilities, "utf8"));
    if (capabilities.status !== "ready") throw new Error("Worker is starting");
    return response.status(200).json({ ok: true, service: "media-toolbox", worker: "ready", time: new Date().toISOString() });
  } catch {
    return response.status(503).json({ ok: false, service: "media-toolbox", worker: "unavailable" });
  }
}
