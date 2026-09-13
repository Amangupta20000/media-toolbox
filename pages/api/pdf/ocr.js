import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appConfig, likelyFileForTool, parseMultipart, paths } from "../../../lib/job-intake.js";
import { recognizePdfText } from "../../../lib/pdf-ocr.js";

export const config = { api: { bodyParser: false, responseLimit: false, externalResolver: true } };

function writeOcrEvent(response, payload) {
  if (!response.writableEnded) response.write(`${JSON.stringify(payload)}\n`);
}

export default async function handler(request, response) {
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed" });
  const workDirectory = path.join(paths.jobs, `ocr-${randomUUID()}`);
  await fsPromises.mkdir(workDirectory, { recursive: true });
  let streamed = false;
  try {
    const { fields, files } = await parseMultipart(request, workDirectory, { fileSize: appConfig.pdfMaxBytes });
    const sources = files.filter((file) => file.field === "source");
    if (sources.length !== 1) throw new Error("Add exactly one PDF for OCR.");
    const source = sources[0];
    if (!likelyFileForTool(source, "pdf-text-editor")) throw new Error("The uploaded file is not a PDF.");
    if (source.size > appConfig.pdfMaxBytes) throw new Error("The PDF is larger than the 200 MB limit.");
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders?.();
    streamed = true;
    writeOcrEvent(response, { type: "progress", progress: 1, status: "starting", message: "Starting OCR…" });
    const result = await recognizePdfText(await fsPromises.readFile(source.path), {
      password: fields.password || "",
      onProgress: (progress) => writeOcrEvent(response, { type: "progress", ...progress }),
    });
    writeOcrEvent(response, { type: "result", result });
    response.end();
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The PDF could not be scanned with OCR.";
    if (streamed) {
      writeOcrEvent(response, { type: "error", error: message });
      response.end();
      return;
    }
    return response.status(/PasswordException|password/i.test(message) ? 422 : 400).json({ error: message });
  } finally {
    await fsPromises.rm(workDirectory, { recursive: true, force: true });
  }
}
