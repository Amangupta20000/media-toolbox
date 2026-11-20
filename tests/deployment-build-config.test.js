import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("deployment Node.js range stays on supported LTS versions", async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"));

  assert.equal(packageJson.engines.node, ">=20.9.0 <25");
  assert.equal(packageLock.packages[""].engines.node, packageJson.engines.node);
});
