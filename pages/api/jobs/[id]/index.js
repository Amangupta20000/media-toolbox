import { getJobForPublic } from "../../../../lib/db.js";

export default function handler(request, response) {
  const job = getJobForPublic(request.query.id);
  if (!job) return response.status(404).json({ error: "Job not found" });
  return response.status(200).json(job);
}
