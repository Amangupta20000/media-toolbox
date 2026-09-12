import Busboy from "busboy";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { config as appConfig, paths } from "../../../lib/config.js";

export const config = { api: { bodyParser: false, responseLimit: false, externalResolver: true } };

function readPdfUpload(request) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"];
    if (!contentType?.includes("multipart/form-data")) {
      reject(new Error("Expected a multipart PDF upload."));
      return;
    }

    const parser = Busboy({
      headers: { "content-type": contentType },
      limits: { files: 1, fileSize: appConfig.pdfMaxBytes },
    });
    const chunks = [];
    let filename = "upload.pdf";
    let fileSeen = false;
    let truncated = false;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    parser.on("file", (field, file, info) => {
      if (field !== "pdf" || fileSeen) {
        file.resume();
        return;
      }
      fileSeen = true;
      filename = info.filename || filename;
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("limit", () => { truncated = true; });
      file.on("error", fail);
    });
    parser.on("error", fail);
    parser.on("finish", () => {
      if (settled) return;
      if (!fileSeen) return fail(new Error("Add a PDF to inspect."));
      if (truncated) return fail(new Error("The PDF is larger than the 15 MB limit."));
      settled = true;
      resolve({ filename, bytes: Buffer.concat(chunks) });
    });
    request.pipe(parser);
  });
}

export default async function handler(request, response) {
  if (request.method !== "POST") return response.status(405).json({ error: "Method not allowed" });
  try {
    const { filename, bytes } = await readPdfUpload(request);
    if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error(`${filename} does not contain a valid PDF header.`);
    const document = await PDFDocument.load(bytes);
    const pages = document.getPages().map((page) => {
      const size = page.getSize();
      return { width: size.width, height: size.height, rotation: page.getRotation().angle || 0 };
    });
    if (!pages.length) throw new Error("The PDF has no pages.");
    const previewToken = randomUUID();
    const previewDir = path.join(paths.pdfPreviews, previewToken);
    await fsPromises.mkdir(previewDir, { recursive: true });
    await fsPromises.writeFile(path.join(previewDir, "source.pdf"), bytes, { flag: "wx" });
    response.setHeader("Cache-Control", "no-store");
    return response.status(200).json({ pageCount: pages.length, pages, previewToken });
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "The PDF could not be inspected." });
  }
}
