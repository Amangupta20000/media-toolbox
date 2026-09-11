import fs from "node:fs";
import { getJob } from "../../../../lib/db.js";

export const config = { api: { responseLimit: false } };

function safeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function contentType(filename) {
  const extension = filename.toLowerCase().split(".").pop();
  return {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    heic: "image/heic",
    heif: "image/heif",
    tiff: "image/tiff",
    tif: "image/tiff",
    gif: "image/gif",
    bmp: "image/bmp",
    pdf: "application/pdf",
    mp4: "video/mp4",
    m4v: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mkv: "video/x-matroska",
  }[extension] || "application/octet-stream";
}

export default function handler(request, response) {
  const job = getJob(request.query.id);
  if (!job || job.status !== "completed" || !job.result_json) {
    response.status(404).json({ error: "Result is not available" });
    return;
  }
  const result = JSON.parse(job.result_json);
  if (!result.path || !fs.existsSync(result.path)) {
    response.status(410).json({ error: "Result has expired" });
    return;
  }
  const preview = request.query.preview === "1";
  const fileSize = fs.statSync(result.path).size;
  let start = 0;
  let end = fileSize - 1;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      response.setHeader("Content-Range", `bytes */${fileSize}`);
      response.status(416).end();
      return;
    }
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    else end = fileSize - 1;
    if (!match[1]) start = Math.max(fileSize - Number(match[2]), 0);
    end = Math.min(end, fileSize - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= fileSize) {
      response.setHeader("Content-Range", `bytes */${fileSize}`);
      response.status(416).end();
      return;
    }
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  }
  const type = contentType(result.filename || "");
  response.setHeader("Content-Type", type === "application/pdf" || preview ? type : "application/octet-stream");
  response.setHeader("Content-Disposition", `${preview ? "inline" : "attachment"}; filename="${safeFilename(result.filename || "download")}"`);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Length", String(end - start + 1));
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(result.path, { start, end }).on("error", () => response.destroy()).pipe(response);
}
