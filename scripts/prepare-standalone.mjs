import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const copies = [
  ["public", ".next/standalone/public"],
  [".next/static", ".next/standalone/.next/static"],
];

for (const [source, destination] of copies) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

console.log("Prepared the standalone server with public assets.");
