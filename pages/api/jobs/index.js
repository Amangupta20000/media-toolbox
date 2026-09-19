import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createJobFromMultipart, parseMultipart, paths } from "../../../lib/job-intake.js";
import { adminTokenFromRequest, isValidLicenseAdminToken } from "../../../lib/admin-access.js";

export const config = { api: { bodyParser: false, responseLimit: false, externalResolver: true } };

async function serverWorkerReady() {
  try {
    const capabilities = JSON.parse(await fsPromises.readFile(paths.capabilities, "utf8"));
    return capabilities.status === "ready";
  } catch {
    return false;
  }
}

export default async function handler(request, response) {
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed" });
  if (!(await serverWorkerReady())) {
    return response.status(503).json({
      error: "Server processing is temporarily unavailable. Start the worker or choose Local agent and try again.",
      code: "worker_unavailable",
    });
  }
  const id = randomUUID();
  const jobDir = path.join(paths.jobs, id);
  await fsPromises.mkdir(jobDir, { recursive: true });
  try {
    const { fields, files } = await parseMultipart(request, jobDir);
    const remoteMediaRequested = fields.tool === "audio-extractor" && String(fields.sourceUrl || "").trim();
    const allowRemoteMediaUrl = !remoteMediaRequested || await isValidLicenseAdminToken(adminTokenFromRequest(request));
    if (remoteMediaRequested && !allowRemoteMediaUrl) {
      const error = new Error("Media URL extraction is restricted to an authorized Admin session.");
      error.statusCode = 403;
      error.code = "admin_required_for_media_url";
      throw error;
    }
    const result = await createJobFromMultipart({ id, jobDir, fields, files, allowRemoteMediaUrl });
    const ids = result?.ids || [id];
    return response.status(202).json({ ...(ids.length === 1 ? { jobId: ids[0] } : { jobIds: ids }), status: "queued" });
  } catch (error) {
    await fsPromises.rm(jobDir, { recursive: true, force: true });
    return response.status(Number(error?.statusCode) || 400).json({ error: error instanceof Error ? error.message : "Upload failed.", ...(error?.code ? { code: error.code } : {}) });
  }
}
