import fs from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const workerPath = require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  try {
    const worker = await fs.readFile(workerPath);
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.setHeader("Content-Length", String(worker.byteLength));
    return response.status(200).send(worker);
  } catch {
    return response.status(500).json({ error: "The PDF preview worker is unavailable." });
  }
}
