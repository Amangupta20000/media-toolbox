import assert from "node:assert/strict";
import test from "node:test";
import { hasActiveAuthorizedLicense } from "../lib/free-access.js";

const now = 1_800_000_000_000;

test("offer popup suppression requires a connected active authorized license", () => {
  assert.equal(hasActiveAuthorizedLicense({ connected: false, authorization: { mode: "activation", authorized: true, expiresAt: now + 60_000 } }, now), false);
  assert.equal(hasActiveAuthorizedLicense({ connected: true, authorization: { mode: "locked", authorized: false } }, now), false);
  assert.equal(hasActiveAuthorizedLicense({ connected: true, authorization: { mode: "trial", authorized: true, expiresAt: now + 60_000 } }, now), false);
  assert.equal(hasActiveAuthorizedLicense({ connected: true, authorization: { mode: "activation", authorized: true, expiresAt: now + 60_000 } }, now), true);
  assert.equal(hasActiveAuthorizedLicense({ connected: true, health: { authorization: { mode: "activation", authorized: true, expiresAt: now + 60_000 } } }, now), true);
  assert.equal(hasActiveAuthorizedLicense({ connected: true, authorization: { mode: "activation", authorized: true, expiresAt: now } }, now), false);
  assert.equal(hasActiveAuthorizedLicense({ connected: true, authorization: { mode: "admin", authorized: true } }, now), true);
});
