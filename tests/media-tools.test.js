import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test, { after, before } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { commandExists, firstAvailable, runCommand } from "../lib/command.js";

const projectDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-test-"));
process.env.DATA_DIR = path.join(testRoot, "data");
process.env.UNTRUNC_PATH = path.join(projectDir, "vendor", "untrunc-macos", "untrunc");
process.env.UNTRUNC_REFERENCE_PATH = "";

const db = await import("../lib/db.js");
const worker = await import("../worker/index.js");
const { createJobFromMultipart } = await import("../lib/job-intake.js");

after(async () => {
  await fs.rm(testRoot, { recursive: true, force: true });
});

async function command(command, args) {
  const result = await runCommand(command, args);
  assert.equal(result.code, 0, `${command} failed:\n${result.stderr}`);
  return result;
}

async function sha256(filename) {
  return crypto.createHash("sha256").update(await fs.readFile(filename)).digest("hex");
}

async function createJob(input) {
  const id = crypto.randomUUID();
  db.createJob({ id, ...input });
  return db.getJob(id);
}

async function metadataFor(imageTool, filename) {
  const args = ["-format", "%m|%w|%h|%[channels]", `${filename}[0]`];
  const result = await runCommand(imageTool === "magick" ? "magick" : "identify", imageTool === "magick" ? ["identify", ...args] : args);
  assert.equal(result.code, 0, result.stderr);
  const [format, width, height, channels] = result.stdout.trim().split("|");
  return { format, width: Number(width), height: Number(height), channels };
}

async function createPdf(filename, label, sizes) {
  const document = await PDFDocument.create();
  sizes.forEach(([width, height], index) => {
    const page = document.addPage([width, height]);
    page.drawText(`${label} page ${index + 1}`, { x: 18, y: height - 36, size: 18 });
  });
  await fs.writeFile(filename, await document.save());
}

function multipartBody(parts) {
  const boundary = `----MediaToolboxTest${crypto.randomUUID()}`;
  const chunks = [];
  for (const part of parts) {
    const disposition = `Content-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ""}`;
    const type = part.filename ? `\r\nContent-Type: ${part.type || "application/octet-stream"}` : "";
    chunks.push(Buffer.from(`--${boundary}\r\n${disposition}${type}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data || "")));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

function mockJsonResponse() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); },
  };
}

function removeTopLevelAtom(buffer, atomName) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const atomSize = size === 1 ? Number(buffer.readBigUInt64BE(offset + 8)) : size;
    if (!atomSize || offset + atomSize > buffer.length) break;
    if (type === atomName) return Buffer.concat([buffer.subarray(0, offset), buffer.subarray(offset + atomSize)]);
    offset += atomSize;
  }
  throw new Error(`Could not find ${atomName} atom.`);
}

test("image converter copies original format without modifying the source", async () => {
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (!imageTool) return;
  const sourcePath = path.join(testRoot, "original.png");
  await command(imageTool === "magick" ? "magick" : "convert", ["-size", "120x80", "xc:skyblue", sourcePath]);
  const sourceHash = await sha256(sourcePath);
  const job = await createJob({
    tool: "image-converter",
    sourcePath,
    sourceName: "original.png",
    options: { format: "original", method: "imagemagick", jpegConfirmed: false },
  });

  await worker.processImage(job);
  const completed = db.getJob(job.id);
  const result = JSON.parse(completed.result_json);
  assert.equal(completed.status, "completed");
  assert.equal(result.outputFormat, "png");
  assert.equal(await sha256(sourcePath), sourceHash);
  assert.equal(await fs.stat(result.path).then((stat) => stat.isFile()), true);
  assert.equal(await sha256(result.path), sourceHash);
});

test("image size targets bring a smaller output close to the requested KB", async () => {
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (!imageTool) return;
  const sourcePath = path.join(testRoot, "small-target.png");
  const convertCommand = imageTool === "magick" ? "magick" : "convert";
  await command(convertCommand, ["-size", "120x80", "xc:skyblue", sourcePath]);
  const sourceHash = await sha256(sourcePath);
  const job = await createJob({
    tool: "image-converter",
    sourcePath,
    sourceName: "small-target.png",
    options: { format: "original", method: "imagemagick", maxSizeKb: 64, jpegConfirmed: false },
  });

  await worker.processImage(job);
  const completed = db.getJob(job.id);
  const result = JSON.parse(completed.result_json);
  const outputMetadata = await metadataFor(imageTool, result.path);
  const outputBytes = await fs.stat(result.path).then((stat) => stat.size);
  assert.equal(completed.status, "completed");
  assert.equal(result.targetMet, true);
  assert.equal(result.targetSizeKb, 64);
  assert.equal(outputBytes, 64 * 1000);
  assert.equal(outputMetadata.width, 120);
  assert.equal(outputMetadata.height, 80);
  assert.equal(await sha256(sourcePath), sourceHash);
});

test("image PNG targets do not let a JPEG photo expand past the requested size", async () => {
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (!imageTool) return;
  const sourcePath = path.join(testRoot, "photo-source.jpg");
  const convertCommand = imageTool === "magick" ? "magick" : "convert";
  await command(convertCommand, ["-size", "600x900", "plasma:fractal", "-quality", "88", sourcePath]);
  const sourceHash = await sha256(sourcePath);
  const job = await createJob({
    tool: "image-converter",
    sourcePath,
    sourceName: "photo-source.jpg",
    options: { format: "png", method: "imagemagick", maxSizeKb: 200, jpegConfirmed: false },
  });

  await worker.processImage(job);
  const completed = db.getJob(job.id);
  const result = JSON.parse(completed.result_json);
  const outputMetadata = await metadataFor(imageTool, result.path);
  const outputBytes = await fs.stat(result.path).then((stat) => stat.size);
  assert.equal(completed.status, "completed");
  assert.equal(result.outputFormat, "png");
  assert.equal(result.targetMet, true);
  assert.equal(result.targetSizeKb, 200);
  assert.equal(outputBytes, 200 * 1000);
  assert.equal(outputMetadata.format, "PNG");
  assert.equal(outputMetadata.width, 600);
  assert.equal(outputMetadata.height, 900);
  assert.ok(result.pngColors < 256);
  assert.equal(await sha256(sourcePath), sourceHash);
});

test("command runner forwards live stderr output", async () => {
  let observed = "";
  const result = await runCommand(process.execPath, ["-e", "console.error('progress update')"], { onStderr: (chunk) => { observed += chunk; } });
  assert.equal(result.code, 0);
  assert.match(observed, /progress update/);
});

test("image converter preserves pixels and reports JPEG transparency flattening", async () => {
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (!imageTool) return;
  const sourcePath = path.join(testRoot, "transparent.png");
  const convertCommand = imageTool === "magick" ? "magick" : "convert";
  await command(convertCommand, ["-size", "160x100", "xc:none", "-fill", "red", "-draw", "circle 55,50 55,10", sourcePath]);
  const sourceHash = await sha256(sourcePath);
  const job = await createJob({
    tool: "image-converter",
    sourcePath,
    sourceName: "transparent.png",
    options: { format: "jpeg", method: "imagemagick", jpegConfirmed: true },
  });

  await worker.processImage(job);
  const completed = db.getJob(job.id);
  const result = JSON.parse(completed.result_json);
  const outputMetadata = await metadataFor(imageTool, result.path);
  assert.equal(completed.status, "completed");
  assert.equal(result.outputFormat, "jpeg");
  assert.equal(outputMetadata.format, "JPEG");
  assert.equal(outputMetadata.width, 160);
  assert.equal(outputMetadata.height, 100);
  assert.equal(completed.warnings_json.includes("transparency"), true);
  assert.equal(await sha256(sourcePath), sourceHash);
});

test("image intake accepts five images with independent output settings", async () => {
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (!imageTool) return;
  const convertCommand = imageTool === "magick" ? "magick" : "convert";
  const jobDir = path.join(testRoot, "image-batch-intake");
  await fs.mkdir(jobDir, { recursive: true });
  const firstSource = path.join(jobDir, "first.png");
  const secondSource = path.join(jobDir, "second.jpg");
  await command(convertCommand, ["-size", "160x100", "xc:tomato", firstSource]);
  await command(convertCommand, ["-size", "120x80", "xc:royalblue", secondSource]);

  const result = await createJobFromMultipart({
    id: crypto.randomUUID(),
    jobDir,
    fields: {
      tool: "image-converter",
      method: "imagemagick",
      imageOptions: JSON.stringify([
        { format: "jpeg", maxSizeKb: 64, jpegConfirmed: true },
        { format: "png", maxSizeKb: "", jpegConfirmed: false },
      ]),
    },
    files: [
      { field: "source", name: "first.png", mime: "image/png", path: firstSource, size: (await fs.stat(firstSource)).size },
      { field: "source", name: "second.jpg", mime: "image/jpeg", path: secondSource, size: (await fs.stat(secondSource)).size },
    ],
  });

  assert.equal(result.ids.length, 2);
  const firstJob = db.getJob(result.ids[0]);
  const secondJob = db.getJob(result.ids[1]);
  const firstOptions = JSON.parse(firstJob.options_json);
  const secondOptions = JSON.parse(secondJob.options_json);
  assert.equal(firstOptions.format, "jpeg");
  assert.equal(firstOptions.maxSizeKb, 64);
  assert.equal(firstOptions.jpegConfirmed, true);
  assert.equal(secondOptions.format, "png");
  assert.equal(secondOptions.maxSizeKb, undefined);
  assert.notEqual(firstJob.source_path, secondJob.source_path);

  await worker.processJob(firstJob);
  await worker.processJob(secondJob);
  const firstCompleted = db.getJob(result.ids[0]);
  const secondCompleted = db.getJob(result.ids[1]);
  assert.equal(firstCompleted.status, "completed");
  assert.equal(secondCompleted.status, "completed");
  assert.equal(JSON.parse(firstCompleted.result_json).outputFormat, "jpeg");
  assert.equal(JSON.parse(secondCompleted.result_json).outputFormat, "png");

  result.ids.forEach((id) => db.deleteJob(id));
  await fs.rm(jobDir, { recursive: true, force: true });
});

test("image intake rejects more than five source images", async () => {
  await assert.rejects(
    () => createJobFromMultipart({
      id: crypto.randomUUID(),
      jobDir: testRoot,
      fields: { tool: "image-converter", imageOptions: "[]" },
      files: Array.from({ length: 6 }, (_, index) => ({ field: "source", name: `image-${index}.png`, mime: "image/png", path: path.join(testRoot, `image-${index}.png`), size: 1 })),
    }),
    /up to 5 images/i,
  );
});

test("image jobs API returns one queued job ID per uploaded image", async () => {
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (!imageTool) return;
  const convertCommand = imageTool === "magick" ? "magick" : "convert";
  const firstSource = path.join(testRoot, "api-batch-first.png");
  const secondSource = path.join(testRoot, "api-batch-second.png");
  await command(convertCommand, ["-size", "40x40", "xc:gold", firstSource]);
  await command(convertCommand, ["-size", "50x30", "xc:purple", secondSource]);
  const upload = multipartBody([
    { name: "tool", data: "image-converter" },
    { name: "method", data: "imagemagick" },
    { name: "imageOptions", data: JSON.stringify([{ format: "png", jpegConfirmed: false }, { format: "jpeg", jpegConfirmed: true }]) },
    { name: "source", filename: "api-batch-first.png", type: "image/png", data: await fs.readFile(firstSource) },
    { name: "source", filename: "api-batch-second.png", type: "image/png", data: await fs.readFile(secondSource) },
  ]);
  const request = new PassThrough();
  request.method = "POST";
  request.headers = { "content-type": `multipart/form-data; boundary=${upload.boundary}` };
  const response = mockJsonResponse();
  const api = await import("../pages/api/jobs/index.js");
  const requestPromise = api.default(request, response);
  request.end(upload.body);
  await requestPromise;

  assert.equal(response.statusCode, 202);
  assert.equal(response.payload.status, "queued");
  assert.equal(response.payload.jobIds.length, 2);
  const jobs = response.payload.jobIds.map((id) => db.getJob(id));
  assert.equal(jobs.every((job) => job?.tool === "image-converter" && job.status === "queued"), true);
  assert.deepEqual(jobs.map((job) => JSON.parse(job.options_json).format), ["png", "jpeg"]);
  const jobDirectories = new Set(jobs.map((job) => path.dirname(path.dirname(job.source_path))));
  for (const job of jobs) db.deleteJob(job.id);
  for (const directory of jobDirectories) await fs.rm(directory, { recursive: true, force: true });
});

test("PDF editor reorders pages, creates a blank page with an image, and preserves the source", async (t) => {
  const sourcePath = path.join(testRoot, "single-source.pdf");
  await createPdf(sourcePath, "Single", [[300, 400], [500, 600]]);
  const sourceHash = await sha256(sourcePath);
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (!imageTool) {
    t.skip("ImageMagick is required for the inserted-image fixture.");
    return;
  }
  const imagePath = path.join(testRoot, "inserted.png");
  const convertCommand = imageTool === "magick" ? "magick" : "convert";
  await command(convertCommand, ["-size", "80x40", "xc:tomato", imagePath]);
  const jobDir = path.join(testRoot, "pdf-single-job");
  await fs.mkdir(jobDir, { recursive: true });
  const manifestPath = path.join(jobDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    pdfs: [{ path: sourcePath, name: "single-source.pdf", size: (await fs.stat(sourcePath)).size }],
    pages: [
      { kind: "source", pdfIndex: 0, pageIndex: 1 },
      { kind: "blank", width: 595.28, height: 841.89, rotation: 0, imagePath, imageName: "inserted.png", imageMime: "image/png", image: { x: 50, y: 60, width: 160, height: 80 } },
      { kind: "source", pdfIndex: 0, pageIndex: 0 },
    ],
  }));
  const job = await createJob({ tool: "pdf-editor", sourcePath: manifestPath, sourceName: "PDF editor project", options: { pdfCount: 1, pageCount: 3 } });
  await worker.processJob(job);

  const completed = db.getJob(job.id);
  const result = JSON.parse(completed.result_json);
  const output = await PDFDocument.load(await fs.readFile(result.path));
  const sizes = output.getPages().map((page) => page.getSize()).map(({ width, height }) => [Math.round(width), Math.round(height)]);
  assert.equal(completed.status, "completed");
  assert.equal(result.pageCount, 3);
  assert.deepEqual(sizes, [[500, 600], [595, 842], [300, 400]]);
  assert.equal(db.getJobForPublic(job.id).logs.some((entry) => entry.message.includes("Worker started PDF editing")), true);
  assert.equal(db.getJobForPublic(job.id).progress, 100);
  assert.equal(await sha256(sourcePath), sourceHash);
});

test("PDF editor embeds multiple images on one blank page", async (t) => {
  const sourcePath = path.join(testRoot, "multi-image-source.pdf");
  await createPdf(sourcePath, "Multiple images", [[420, 560]]);
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (!imageTool) {
    t.skip("ImageMagick is required for the inserted-image fixtures.");
    return;
  }
  const imageOnePath = path.join(testRoot, "inserted-one.png");
  const imageTwoPath = path.join(testRoot, "inserted-two.png");
  const convertCommand = imageTool === "magick" ? "magick" : "convert";
  await command(convertCommand, ["-size", "80x40", "xc:tomato", imageOnePath]);
  await command(convertCommand, ["-size", "50x70", "xc:royalblue", imageTwoPath]);
  const jobDir = path.join(testRoot, "pdf-multi-image-job");
  await fs.mkdir(jobDir, { recursive: true });
  const manifestPath = path.join(jobDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    pdfs: [{ path: sourcePath, name: "multi-image-source.pdf", size: (await fs.stat(sourcePath)).size }],
    pages: [
      { kind: "blank", width: 420, height: 560, rotation: 270, images: [
        { path: imageOnePath, name: "inserted-one.png", mime: "image/png", placement: { x: -25, y: 500, width: 160, height: 80 } },
        { path: imageTwoPath, name: "inserted-two.png", mime: "image/png", placement: { x: 220, y: 300, width: 100, height: 140 } },
      ] },
      { kind: "source", pdfIndex: 0, pageIndex: 0, width: 420, height: 560, rotation: 90, images: [
        { path: imageOnePath, name: "inserted-one.png", mime: "image/png", placement: { x: 360, y: -20, width: 160, height: 80 } },
      ] },
    ],
  }));
  const job = await createJob({ tool: "pdf-editor", sourcePath: manifestPath, sourceName: "PDF editor project", options: { pdfCount: 1, pageCount: 2 } });
  await worker.processJob(job);

  const completed = db.getJob(job.id);
  const result = JSON.parse(completed.result_json);
  const output = await PDFDocument.load(await fs.readFile(result.path));
  assert.equal(completed.status, "completed");
  assert.equal(output.getPageCount(), 2);
  assert.equal(result.pageCount, 2);
  assert.equal(output.getPage(0).getRotation().angle, 270);
  assert.equal(output.getPage(1).getRotation().angle, 90);
});

test("PDF editor merges five PDFs in manifest order and keeps every source unchanged", async () => {
  const sourceFiles = [];
  const sourceHashes = [];
  for (let index = 0; index < 5; index += 1) {
    const filename = path.join(testRoot, `merge-${index + 1}.pdf`);
    await createPdf(filename, `Merge ${index + 1}`, [[300 + index, 400 + index]]);
    sourceFiles.push(filename);
    sourceHashes.push(await sha256(filename));
  }
  const jobDir = path.join(testRoot, "pdf-five-job");
  await fs.mkdir(jobDir, { recursive: true });
  const manifestPath = path.join(jobDir, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    pdfs: sourceFiles.map((file, index) => ({ path: file, name: path.basename(file), size: 1 })),
    pages: sourceFiles.map((file, index) => ({ kind: "source", pdfIndex: index, pageIndex: 0 })),
  }));
  const job = await createJob({ tool: "pdf-editor", sourcePath: manifestPath, sourceName: "PDF editor project", options: { pdfCount: 5, pageCount: 5 } });
  await worker.processJob(job);

  const completed = db.getJob(job.id);
  const result = JSON.parse(completed.result_json);
  const output = await PDFDocument.load(await fs.readFile(result.path));
  assert.equal(completed.status, "completed");
  assert.equal(result.pageCount, 5);
  assert.equal(output.getPageCount(), 5);
  assert.equal(result.filename, "merged_edited.pdf");
  for (const [index, file] of sourceFiles.entries()) assert.equal(await sha256(file), sourceHashes[index]);
});

test("PDF editor rejects a sixth PDF and unsupported inserted images at upload validation", async () => {
  const sourcePath = path.join(testRoot, "validation-source.pdf");
  await createPdf(sourcePath, "Validation", [[300, 400]]);
  const sourceBytes = await fs.readFile(sourcePath);
  const api = await import("../pages/api/jobs/index.js");
  const sixthUpload = multipartBody([
    { name: "tool", data: "pdf-editor" },
    { name: "operations", data: JSON.stringify([{ kind: "source", pdfIndex: 0, pageIndex: 0 }]) },
    ...Array.from({ length: 6 }, (_, index) => ({ name: "pdf", filename: `source-${index + 1}.pdf`, type: "application/pdf", data: sourceBytes })),
  ]);
  const sixthRequest = new PassThrough();
  sixthRequest.method = "POST";
  sixthRequest.headers = { "content-type": `multipart/form-data; boundary=${sixthUpload.boundary}` };
  const sixthResponse = mockJsonResponse();
  const sixthPromise = api.default(sixthRequest, sixthResponse);
  sixthRequest.end(sixthUpload.body);
  await sixthPromise;
  assert.equal(sixthResponse.statusCode, 400);
  assert.match(sixthResponse.payload.error, /up to 5 PDFs/i);

  const invalidImageUpload = multipartBody([
    { name: "tool", data: "pdf-editor" },
    { name: "operations", data: JSON.stringify([{ kind: "blank", width: 300, height: 400, rotation: 0, imageField: "page-image-invalid", image: { x: 0, y: 0, width: 50, height: 50 } }]) },
    { name: "pdf", filename: "source.pdf", type: "application/pdf", data: sourceBytes },
    { name: "page-image-invalid", filename: "notes.txt", type: "text/plain", data: "not an image" },
  ]);
  const invalidRequest = new PassThrough();
  invalidRequest.method = "POST";
  invalidRequest.headers = { "content-type": `multipart/form-data; boundary=${invalidImageUpload.boundary}` };
  const invalidResponse = mockJsonResponse();
  const invalidPromise = api.default(invalidRequest, invalidResponse);
  invalidRequest.end(invalidImageUpload.body);
  await invalidPromise;
  assert.equal(invalidResponse.statusCode, 400);
  assert.match(invalidResponse.payload.error, /not a supported image/i);

  await assert.rejects(
    () => createJobFromMultipart({
      id: crypto.randomUUID(),
      jobDir: testRoot,
      fields: { tool: "pdf-editor", operations: JSON.stringify([{ kind: "source", pdfIndex: 0, pageIndex: 0 }]) },
      files: [{ field: "pdf", name: "oversized.pdf", mime: "application/pdf", path: sourcePath, size: 15 * 1024 * 1024 + 1 }],
    }),
    /15 MB PDF limit/i,
  );
});

test("PDF browser fallback inspection returns page metadata and rejects invalid files", async () => {
  const sourcePath = path.join(testRoot, "browser-fallback.pdf");
  await createPdf(sourcePath, "Browser fallback", [[1620, 912], [420, 640]]);
  const api = await import("../pages/api/pdf/inspect.js");
  const validUpload = multipartBody([{ name: "pdf", filename: "browser-fallback.pdf", type: "application/pdf", data: await fs.readFile(sourcePath) }]);
  const validRequest = new PassThrough();
  validRequest.method = "POST";
  validRequest.headers = { "content-type": `multipart/form-data; boundary=${validUpload.boundary}` };
  const validResponse = mockJsonResponse();
  const validPromise = api.default(validRequest, validResponse);
  validRequest.end(validUpload.body);
  await validPromise;
  assert.equal(validResponse.statusCode, 200);
  assert.equal(validResponse.payload.pageCount, 2);
  assert.deepEqual(validResponse.payload.pages[0], { width: 1620, height: 912, rotation: 0 });

  const previewApi = await import("../pages/api/pdf/preview.js");
  const previewResponse = new PassThrough();
  const previewHeaders = {};
  previewResponse.setHeader = (name, value) => { previewHeaders[name.toLowerCase()] = String(value); };
  const previewChunks = [];
  previewResponse.on("data", (chunk) => previewChunks.push(chunk));
  const previewEnded = once(previewResponse, "end");
  await previewApi.default({ method: "GET", query: { token: validResponse.payload.previewToken, page: "1", thumbnail: "1" } }, previewResponse);
  await previewEnded;
  assert.equal(previewHeaders["content-type"], "image/png");
  assert.equal(Buffer.concat(previewChunks).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  const invalidUpload = multipartBody([{ name: "pdf", filename: "not-a-pdf.pdf", type: "application/pdf", data: "not a PDF" }]);
  const invalidRequest = new PassThrough();
  invalidRequest.method = "POST";
  invalidRequest.headers = { "content-type": `multipart/form-data; boundary=${invalidUpload.boundary}` };
  const invalidResponse = mockJsonResponse();
  const invalidPromise = api.default(invalidRequest, invalidResponse);
  invalidRequest.end(invalidUpload.body);
  await invalidPromise;
  assert.equal(invalidResponse.statusCode, 400);
  assert.match(invalidResponse.payload.error, /valid PDF header/i);
});

test("PDF editor fails clearly for an invalid source page and serves a PDF with download headers", async () => {
  const sourcePath = path.join(testRoot, "download-source.pdf");
  await createPdf(sourcePath, "Download", [[320, 480]]);
  const invalidDir = path.join(testRoot, "pdf-invalid-job");
  await fs.mkdir(invalidDir, { recursive: true });
  const invalidManifest = path.join(invalidDir, "manifest.json");
  await fs.writeFile(invalidManifest, JSON.stringify({ pdfs: [{ path: sourcePath, name: "download-source.pdf", size: 1 }], pages: [{ kind: "source", pdfIndex: 0, pageIndex: 4 }] }));
  const invalidJob = await createJob({ tool: "pdf-editor", sourcePath: invalidManifest, sourceName: "PDF editor project", options: {} });
  await worker.processJob(invalidJob);
  const failed = db.getJob(invalidJob.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /no longer available/i);

  const validDir = path.join(testRoot, "pdf-download-job");
  await fs.mkdir(validDir, { recursive: true });
  const validManifest = path.join(validDir, "manifest.json");
  await fs.writeFile(validManifest, JSON.stringify({ pdfs: [{ path: sourcePath, name: "download-source.pdf", size: (await fs.stat(sourcePath)).size }], pages: [{ kind: "source", pdfIndex: 0, pageIndex: 0 }] }));
  const validJob = await createJob({ tool: "pdf-editor", sourcePath: validManifest, sourceName: "PDF editor project", options: {} });
  await worker.processJob(validJob);
  const route = await import("../pages/api/jobs/[id]/download.js");
  const response = new PassThrough();
  const headers = {};
  response.setHeader = (name, value) => { headers[name.toLowerCase()] = String(value); };
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  const ended = once(response, "end");
  route.default({ method: "GET", query: { id: validJob.id }, headers: {} }, response);
  await ended;
  assert.equal(headers["content-type"], "application/pdf");
  assert.match(headers["content-disposition"], /^attachment;/);
  assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), "%PDF-");

  const previewRoute = await import("../pages/api/jobs/[id]/preview.js");
  const previewOutput = new PassThrough();
  const previewOutputHeaders = {};
  previewOutput.setHeader = (name, value) => { previewOutputHeaders[name.toLowerCase()] = String(value); };
  const previewOutputChunks = [];
  previewOutput.on("data", (chunk) => previewOutputChunks.push(chunk));
  const previewOutputEnded = once(previewOutput, "end");
  await previewRoute.default({ method: "GET", query: { id: validJob.id, page: "1" } }, previewOutput);
  await previewOutputEnded;
  assert.equal(previewOutputHeaders["content-type"], "image/png");
  assert.equal(Buffer.concat(previewOutputChunks).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("PDF text editor intake and worker preserve searchable output and live job state", async () => {
  const sourcePath = path.join(testRoot, "text-edit-source.pdf");
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([360, 240]);
  page.drawText("Server and local worker", { x: 24, y: 180, font, size: 18 });
  await fs.writeFile(sourcePath, await document.save());
  const { extractPdfTextRuns } = await import("../lib/pdf-text-editor.js");
  const extracted = await extractPdfTextRuns(await fs.readFile(sourcePath));
  const run = extracted.pages[0].runs[0];
  const result = await createJobFromMultipart({
    id: crypto.randomUUID(),
    jobDir: testRoot,
    fields: {
      tool: "pdf-text-editor",
      edits: JSON.stringify([{ pageIndex: 0, runId: run.runId, originalTextHash: run.originalTextHash, replacementText: "Local and server" }]),
    },
    files: [{ field: "source", name: "text-edit-source.pdf", mime: "application/pdf", path: sourcePath, size: (await fs.stat(sourcePath)).size }],
  });
  const job = db.getJob(result.ids[0]);
  await worker.processJob(job);
  const completed = db.getJob(job.id);
  const publicJob = db.getJobForPublic(job.id);
  const output = JSON.parse(completed.result_json);
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress, 100);
  assert.equal(publicJob.logs.some((entry) => entry.message.includes("PDF text editing")), true);
  assert.equal(output.editCount, 1);
  const edited = await extractPdfTextRuns(await fs.readFile(output.path));
  assert.equal(edited.pages[0].runs[0].text, "Local and server");
});

test("video repair recovers a truncated MP4 with a matching reference", async (t) => {
  const ffmpeg = await firstAvailable(["ffmpeg"]);
  const ffprobe = await firstAvailable(["ffprobe"]);
  const untrunc = await firstAvailable([
    path.join(projectDir, "vendor", "untrunc-macos", "untrunc"),
    process.env.UNTRUNC_PATH,
    "/usr/local/bin/untrunc",
  ].filter(Boolean));
  if (!ffmpeg || !ffprobe || !untrunc) {
    t.skip("FFmpeg, ffprobe, and Untrunc are required for the truncated-MP4 recovery test.");
    return;
  }

  const referencePath = path.join(testRoot, "healthy.mp4");
  const brokenPath = path.join(testRoot, "broken.mp4");
  await command(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
    "-t", "5", "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", referencePath,
  ]);
  await fs.writeFile(brokenPath, removeTopLevelAtom(await fs.readFile(referencePath), "moov"));
  const sourceHash = await sha256(brokenPath);
  const probe = await runCommand(ffprobe, ["-v", "error", brokenPath]);
  assert.notEqual(probe.code, 0, "The fixture should be missing its moov atom.");

  const job = await createJob({
    tool: "video-repair",
    sourcePath: brokenPath,
    sourceName: "broken.mp4",
    referencePath,
    referenceName: "healthy.mp4",
    options: { hasReference: true },
  });
  await worker.processVideo(job);

  const completed = db.getJob(job.id);
  const result = JSON.parse(completed.result_json);
  const outputProbe = await runCommand(ffprobe, ["-v", "error", "-show_entries", "format=format_name", "-of", "default=noprint_wrappers=1", result.path]);
  assert.equal(completed.status, "completed");
  assert.equal(result.method, "Reference-based Untrunc recovery");
  assert.equal(outputProbe.code, 0, outputProbe.stderr);
  assert.match(outputProbe.stdout, /mov|mp4/);
  assert.equal(await sha256(brokenPath), sourceHash);
});

test("video repair salvages a recovered container when some H.264 frames are corrupt", async (t) => {
  const ffmpeg = await firstAvailable(["ffmpeg"]);
  const ffprobe = await firstAvailable(["ffprobe"]);
  const untrunc = await firstAvailable([
    path.join(projectDir, "vendor", "untrunc-macos", "untrunc"),
    process.env.UNTRUNC_PATH,
    "/usr/local/bin/untrunc",
  ].filter(Boolean));
  if (!ffmpeg || !ffprobe || !untrunc) {
    t.skip("FFmpeg, ffprobe, and Untrunc are required for the corrupt-frame validation test.");
    return;
  }

  const referencePath = path.join(testRoot, "corrupt-frame-reference.mp4");
  const brokenPath = path.join(testRoot, "corrupt-frame.mp4");
  await command(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
    "-t", "3", "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", referencePath,
  ]);
  const missingMoov = removeTopLevelAtom(await fs.readFile(referencePath), "moov");
  const mdat = missingMoov.indexOf(Buffer.from("mdat"));
  assert.notEqual(mdat, -1);
  // Leave the MP4/NAL headers intact and damage the first IDR keyframe
  // payload. The first NAL is usually an SEI message, which decoders may
  // safely ignore, so deliberately skip it.
  const firstNalLengthOffset = mdat + 4;
  const firstNalEnd = firstNalLengthOffset + 4 + missingMoov.readUInt32BE(firstNalLengthOffset);
  const idrLength = missingMoov.readUInt32BE(firstNalEnd);
  for (let index = firstNalEnd + 4 + 100; index < Math.min(firstNalEnd + 4 + idrLength, firstNalEnd + 4 + 4000); index += 1) missingMoov[index] ^= 0xff;
  await fs.writeFile(brokenPath, missingMoov);
  const sourceHash = await sha256(brokenPath);

  const job = await createJob({
    tool: "video-repair",
    sourcePath: brokenPath,
    sourceName: "corrupt-frame.mp4",
    referencePath,
    referenceName: "corrupt-frame-reference.mp4",
    options: { hasReference: true },
  });
  await worker.processJob(job);

  const completed = db.getJob(job.id);
  const result = JSON.parse(completed.result_json);
  const outputDecode = await runCommand(ffmpeg, ["-hide_banner", "-nostdin", "-xerror", "-v", "error", "-i", result.path, "-map", "0:v:0", "-f", "null", "-"]);
  assert.equal(completed.status, "completed");
  // The bundled FFmpeg may validate the repaired Untrunc container directly;
  // older/system FFmpeg builds may require the H.264/AAC salvage pass.
  assert.match(result.method, /Reference-based Untrunc recovery|H\.264\/AAC transcode/);
  assert.equal(outputDecode.code, 0, outputDecode.stderr);
  if (/H\.264\/AAC transcode/.test(result.method)) assert.equal(completed.warnings_json.includes("re-encoded"), true);
  assert.equal(await sha256(brokenPath), sourceHash);
});

test("video repair salvages the Record Go missing-moov fixture", async (t) => {
  const ffmpeg = await firstAvailable(["ffmpeg"]);
  const ffprobe = await firstAvailable(["ffprobe"]);
  const untrunc = await firstAvailable([
    path.join(projectDir, "vendor", "untrunc-macos", "untrunc"),
    process.env.UNTRUNC_PATH,
    "/usr/local/bin/untrunc",
  ].filter(Boolean));
  const sourceFixtureCandidates = [
    process.env.MEDIA_TOOLBOX_REAL_VIDEO,
    "/Users/amangupta/Movies/Record Go/2026.09.11_2856.mp4.mp4",
    path.join(projectDir, "data", "jobs", "99d355c4-1d37-4298-8673-e9742a24faf2", "source-2026.09.11_2856.mp4.mp4"),
  ].filter(Boolean);
  let sourceFixture = null;
  for (const candidate of sourceFixtureCandidates) {
    if (await fs.stat(candidate).catch(() => null)) {
      sourceFixture = candidate;
      break;
    }
  }
  const referenceFixture = process.env.MEDIA_TOOLBOX_REAL_REFERENCE || "/Users/amangupta/Movies/Record Go/nutritionist session.mp4";
  if (!ffmpeg || !ffprobe || !untrunc || !sourceFixture || !(await fs.stat(referenceFixture).catch(() => null))) {
    t.skip("The local Record Go fixture, matching reference, FFmpeg, ffprobe, and Untrunc are required for this integration test.");
    return;
  }

  const sourcePath = path.join(testRoot, "record-go-2026.09.11_2856.mp4.mp4");
  await fs.copyFile(sourceFixture, sourcePath);
  const sourceHash = await sha256(sourcePath);
  const job = await createJob({
    tool: "video-repair",
    sourcePath,
    sourceName: "2026.09.11_2856.mp4.mp4",
    referencePath: referenceFixture,
    referenceName: path.basename(referenceFixture),
    options: { hasReference: true },
  });
  await worker.processJob(job);

  const completed = db.getJob(job.id);
  assert.equal(completed.status, "completed", completed.error || "The real Record Go fixture was not repaired.");
  const result = JSON.parse(completed.result_json);
  const outputDecode = await runCommand(ffmpeg, ["-hide_banner", "-nostdin", "-xerror", "-v", "error", "-i", result.path, "-map", "0:v:0", "-f", "null", "-"]);
  const outputProbe = await runCommand(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height", "-of", "default=nw=1", result.path]);
  assert.match(result.method, /Reference-based Untrunc recovery/);
  assert.equal(outputDecode.code, 0, outputDecode.stderr);
  assert.equal(outputProbe.code, 0, outputProbe.stderr);
  assert.equal(completed.warnings_json.includes("damaged frames"), false);
  assert.match(outputProbe.stdout, /codec_name=h264/);
  assert.match(outputProbe.stdout, /codec_type=video/);
  assert.equal(await sha256(sourcePath), sourceHash);
});

test("video repair losslessly remuxes a readable MP4 with audio", async (t) => {
  const ffmpeg = await firstAvailable(["ffmpeg"]);
  const ffprobe = await firstAvailable(["ffprobe"]);
  if (!ffmpeg || !ffprobe) {
    t.skip("FFmpeg and ffprobe are required for the readable-MP4 recovery test.");
    return;
  }

  const sourcePath = path.join(testRoot, "readable-with-audio.mp4");
  await command(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
    "-t", "2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", sourcePath,
  ]);
  const sourceHash = await sha256(sourcePath);
  const job = await createJob({
    tool: "video-repair",
    sourcePath,
    sourceName: "readable-with-audio.mp4",
    options: { hasReference: false },
  });
  await worker.processVideo(job);

  const completed = db.getJob(job.id);
  const result = JSON.parse(completed.result_json);
  const streams = await runCommand(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", result.path]);
  assert.equal(completed.status, "completed");
  assert.equal(result.method, "Lossless FFmpeg remux");
  assert.equal(db.getJobForPublic(job.id).conversion.progress, 100);
  assert.match(db.getJobForPublic(job.id).conversion.current, /^\d{2}:\d{2}:\d{2}/);
  assert.equal(streams.code, 0, streams.stderr);
  assert.match(streams.stdout, /video/);
  assert.match(streams.stdout, /audio/);
  assert.equal(await sha256(sourcePath), sourceHash);
});

test("completed video results support inline byte-range previews", async (t) => {
  const ffmpeg = await firstAvailable(["ffmpeg"]);
  const ffprobe = await firstAvailable(["ffprobe"]);
  if (!ffmpeg || !ffprobe) {
    t.skip("FFmpeg and ffprobe are required for the video preview test.");
    return;
  }

  const sourcePath = path.join(testRoot, "preview-video.mp4");
  await command(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25",
    "-t", "1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", sourcePath,
  ]);
  const job = await createJob({
    tool: "video-repair",
    sourcePath,
    sourceName: "preview-video.mp4",
    options: { hasReference: false },
  });
  await worker.processVideo(job);

  const route = await import("../pages/api/jobs/[id]/download.js");
  const response = new PassThrough();
  const headers = {};
  response.setHeader = (name, value) => { headers[name.toLowerCase()] = String(value); };
  const chunks = [];
  response.on("data", (chunk) => chunks.push(chunk));
  const ended = once(response, "end");
  route.default({ method: "GET", query: { id: job.id, preview: "1" }, headers: { range: "bytes=0-99" } }, response);
  await ended;

  assert.equal(response.statusCode, 206);
  assert.equal(headers["content-type"], "video/mp4");
  assert.match(headers["content-disposition"], /^inline;/);
  assert.equal(headers["accept-ranges"], "bytes");
  assert.equal(headers["content-length"], "100");
  assert.equal(Buffer.concat(chunks).length, 100);
});

test("video repair capability dependencies are discoverable", async () => {
  assert.equal(await commandExists("ffmpeg"), true);
  assert.equal(await commandExists("ffprobe"), true);
});

test("the macOS recovery helper uses the current laptop paths", async (t) => {
  const commandPath = path.resolve(projectDir, "..", "RUN_SCRIPTS", "recover_recording.command");
  const script = await fs.readFile(commandPath, "utf8").catch(() => null);
  if (!script) {
    t.skip("The Desktop recovery helper is not present in this environment.");
    return;
  }

  assert.doesNotMatch(script, /\/Users\/210458\//);
  assert.match(script, /USER_HOME="\$\{HOME:/);
  assert.match(script, /command -v ffmpeg/);
  assert.match(script, /Desktop\/MediaToolbox\/vendor\/untrunc-macos\/untrunc/);
});

test("the web worker has no implicit local Record Go reference", async () => {
  const { config } = await import("../lib/config.js");
  assert.equal(config.untruncReferencePath, "");
});
