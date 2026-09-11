import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getJob } from "../../../../lib/db.js";
import { firstAvailable, runCommand } from "../../../../lib/command.js";

export const config = { api: { responseLimit: false } };

export default async function handler(request, response) {
  if (request.method !== "GET") return response.status(405).json({ error: "Method not allowed" });
  const page = Number(request.query.page || 1);
  if (!Number.isInteger(page) || page < 1 || page > 2000) return response.status(400).json({ error: "The PDF preview page is invalid." });
  const job = getJob(request.query.id);
  if (!job || job.status !== "completed" || !job.result_json) return response.status(404).json({ error: "Result is not available" });

  let result;
  try { result = JSON.parse(job.result_json); } catch { return response.status(404).json({ error: "Result is not available" }); }
  if (!result.path || !fs.existsSync(result.path)) return response.status(410).json({ error: "Result has expired" });
  if (path.extname(result.filename || result.path).toLowerCase() !== ".pdf") return response.status(415).json({ error: "The result is not a PDF." });

  const pdftoppm = await firstAvailable(["pdftoppm"]);
  if (!pdftoppm) return response.status(503).json({ error: "Server PDF preview is unavailable because Poppler is not installed." });
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "media-toolbox-result-preview-"));
  const outputPrefix = path.join(tempDir, `page-${page}-${randomUUID()}`);
  try {
    const rendered = await runCommand(pdftoppm, ["-f", String(page), "-l", String(page), "-singlefile", "-png", "-r", "110", result.path, outputPrefix], { timeoutMs: 120000 });
    const outputPath = `${outputPrefix}.png`;
    if (rendered.code !== 0 || !fs.existsSync(outputPath)) return response.status(400).json({ error: "This output PDF page could not be rendered." });
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "image/png");
    response.setHeader("Content-Disposition", "inline");
    const stream = fs.createReadStream(outputPath);
    const cleanup = () => { fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined); };
    stream.on("error", cleanup);
    response.on("close", cleanup);
    stream.on("close", cleanup);
    stream.pipe(response);
  } catch {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
    return response.status(400).json({ error: "This output PDF page could not be rendered." });
  }
}
