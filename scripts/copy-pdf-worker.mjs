import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectDirectory, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs");
const destination = path.join(projectDirectory, "public", "pdf.worker.min.mjs");

await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.copyFile(source, destination);
console.log("Copied the PDF.js worker to public/pdf.worker.min.mjs");
