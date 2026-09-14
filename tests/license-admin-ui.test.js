import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("web license admin groups audit events and exposes search, OS, and sort controls", async () => {
  const component = await fs.readFile(path.join(root, "components", "license-admin.jsx"), "utf8");
  const styles = await fs.readFile(path.join(root, "styles", "globals.css"), "utf8");

  assert.match(component, /groupedAuditItems/);
  assert.match(component, /auditSearch/);
  assert.match(component, /auditOsFilter/);
  assert.match(component, /auditSort/);
  assert.match(component, /audit-log-controls/);
  assert.match(component, /audit-device-group/);
  assert.match(component, /Operating system/);
  assert.match(component, /Newest activity/);
  assert.match(styles, /\.audit-log-controls/);
  assert.match(styles, /\.audit-device-group/);
});
