import fsPromises from "node:fs/promises";
import path from "node:path";
import { paths } from "../../../../lib/config.js";
import { deleteJob, getJob, getJobForPublic, updateJob } from "../../../../lib/db.js";

export default async function handler(request, response) {
  const id = String(request.query.id || "");
  const job = getJob(id);
  if (!job) return response.status(404).json({ error: "Job not found" });
  if (request.method === "DELETE") {
    if (job.status === "processing") {
      updateJob(id, {
        status: "cancelled",
        progress: 100,
        stage: "Canceled",
        message: "Cancellation requested. Stopping the worker.",
        error: "Canceled by the user.",
      });
      return response.status(202).json({ id, status: "cancelled" });
    }
    const jobDirectory = path.dirname(job.source_path);
    const jobsRoot = `${path.resolve(paths.jobs)}${path.sep}`;
    if (path.resolve(jobDirectory).startsWith(jobsRoot)) await fsPromises.rm(jobDirectory, { recursive: true, force: true });
    deleteJob(id);
    return response.status(200).json({ id, status: "deleted" });
  }
  if (request.method !== "GET") return response.status(405).json({ error: "Method not allowed" });
  return response.status(200).json(getJobForPublic(id));
}
