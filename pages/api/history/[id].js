import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { config } from "../../../lib/config.js";
import { deleteJob, getJob } from "../../../lib/db.js";

function dataPath(value) {
  if (!value) return null;
  const resolved = path.resolve(value);
  const dataRoot = `${path.resolve(config.dataDir)}${path.sep}`;
  return resolved.startsWith(dataRoot) ? resolved : null;
}

export default async function handler(request, response) {
  if (request.method !== "DELETE") return response.status(405).json({ error: "Method not allowed" });
  const job = getJob(request.query.id);
  if (!job || job.status !== "completed" || !job.result_json) return response.status(404).json({ error: "History item not found." });

  let result;
  try { result = JSON.parse(job.result_json); } catch { return response.status(404).json({ error: "History item not found." }); }
  const resultPath = dataPath(result.path);
  const sourceDirectory = dataPath(path.dirname(job.source_path));
  if (!resultPath || !sourceDirectory) return response.status(500).json({ error: "The server result path is invalid." });
  if (!fs.existsSync(resultPath)) return response.status(410).json({ error: "The server result has already expired." });

  await fsPromises.rm(sourceDirectory, { recursive: true, force: true });
  if (!resultPath.startsWith(`${sourceDirectory}${path.sep}`)) await fsPromises.rm(resultPath, { force: true });
  deleteJob(job.id);
  return response.status(200).json({ ok: true, deleted: job.id });
}
