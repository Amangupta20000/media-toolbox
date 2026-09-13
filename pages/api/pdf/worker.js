import fs from "node:fs/promises";
import path from "node:path";

// Keep this path explicit so Next/Vercel can trace the worker file without
// needing pdfjs-dist's package metadata at runtime. The previous
// require.resolve() approach worked in a full checkout but returned 500 in
// the deployed serverless bundle because only the worker asset was traced.
const workerPath = path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs");

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
