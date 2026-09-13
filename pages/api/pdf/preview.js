import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "../../../lib/config.js";
import { firstAvailable, runCommand } from "../../../lib/command.js";

export const config = { api: { responseLimit: false } };

function validToken(value) {
  return /^[a-f0-9-]{36}$/i.test(String(value || ""));
}

export default async function handler(request, response) {
  if (request.method !== "GET") return response.status(405).json({ error: "Method not allowed" });
  const token = String(request.query.token || "");
  const page = Number(request.query.page);
  if (!validToken(token) || !Number.isInteger(page) || page < 1 || page > 2000) return response.status(400).json({ error: "The PDF preview request is invalid." });

  const sourcePath = path.join(paths.pdfPreviews, token, "source.pdf");
  try {
    await fsPromises.access(sourcePath, fs.constants.R_OK);
    const pdftoppm = await firstAvailable(["pdftoppm"]);
    if (!pdftoppm) return response.status(503).json({ error: "Server PDF preview is unavailable because Poppler is not installed." });

    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "media-toolbox-pdf-preview-"));
    const outputPrefix = path.join(tempDir, `page-${page}-${randomUUID()}`);
    const renderResolution = request.query.thumbnail === "1" ? "40" : "180";
    const rendered = await runCommand(pdftoppm, ["-f", String(page), "-l", String(page), "-singlefile", "-png", "-r", renderResolution, sourcePath, outputPrefix], { timeoutMs: 120000 });
    const outputPath = `${outputPrefix}.png`;
    if (rendered.code !== 0) {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
      return response.status(400).json({ error: "This PDF page could not be rendered." });
    }

    response.setHeader("Cache-Control", "private, max-age=300");
    response.setHeader("Content-Type", "image/png");
    response.setHeader("Content-Disposition", "inline");
    const stream = fs.createReadStream(outputPath);
    const cleanup = () => { fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined); };
    stream.on("error", cleanup);
    response.on("close", cleanup);
    stream.on("close", cleanup);
    stream.pipe(response);
  } catch {
    return response.status(404).json({ error: "This PDF preview has expired. Add the PDF again." });
  }
}
