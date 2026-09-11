import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acceptMultipartJob, paths } from "../../../lib/job-intake.js";

export const config = { api: { bodyParser: false, responseLimit: false, externalResolver: true } };

export default async function handler(request, response) {
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed" });
  const id = randomUUID();
  const jobDir = path.join(paths.jobs, id);
  await fsPromises.mkdir(jobDir, { recursive: true });
  try {
    await acceptMultipartJob(request, { id, jobDir });
    return response.status(202).json({ jobId: id, status: "queued" });
  } catch (error) {
    await fsPromises.rm(jobDir, { recursive: true, force: true });
    return response.status(400).json({ error: error instanceof Error ? error.message : "Upload failed." });
  }
}
