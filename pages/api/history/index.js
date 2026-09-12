import fs from "node:fs";
import path from "node:path";
import { config } from "../../../lib/config.js";
import { getJobForPublic, listCompletedJobs } from "../../../lib/db.js";

const HISTORY_TOOLS = new Set(["image-converter", "video-repair", "pdf-editor"]);

function resultPathFor(row) {
  let result;
  try { result = JSON.parse(row.result_json || "{}"); } catch { return null; }
  if (!result.path) return null;
  const resolved = path.resolve(result.path);
  const dataRoot = `${path.resolve(config.dataDir)}${path.sep}`;
  return resolved.startsWith(dataRoot) ? resolved : null;
}

export default function handler(request, response) {
  if (request.method !== "GET") return response.status(405).json({ error: "Method not allowed" });
  const tool = String(request.query.tool || "").trim();
  if (!HISTORY_TOOLS.has(tool)) return response.status(400).json({ error: "Choose a supported tool for history." });

  try {
    const items = listCompletedJobs(tool)
      .filter((row) => {
        const resultPath = resultPathFor(row);
        return Boolean(resultPath && fs.existsSync(resultPath));
      })
      .map((row) => ({ ...getJobForPublic(row.id), storage: "server", storedLocally: false, location: "Server temporary storage · auto-cleaned" }));
    return response.status(200).json({ items });
  } catch (error) {
    console.error("Server history is unavailable:", error);
    return response.status(503).json({ error: "Server history requires a running worker and persistent writable storage. Use the Local agent or connect a persistent backend." });
  }
}
