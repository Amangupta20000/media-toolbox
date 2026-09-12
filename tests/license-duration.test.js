import assert from "node:assert/strict";
import test from "node:test";
import { activationDurationOptions, isAllowedActivationDuration } from "../lib/license-token.js";

test("activation duration allowlist contains only 10m, 30m, 2h, 6h, and 1d", () => {
  assert.deepEqual(activationDurationOptions().map(({ value, durationMs }) => ({ value, durationMs })), [
    { value: "10m", durationMs: 600000 },
    { value: "30m", durationMs: 1800000 },
    { value: "2h", durationMs: 7200000 },
    { value: "6h", durationMs: 21600000 },
    { value: "1d", durationMs: 86400000 },
  ]);
  for (const durationMs of [600000, 1800000, 7200000, 21600000, 86400000]) assert.equal(isAllowedActivationDuration(durationMs), true);
  for (const durationMs of [0, 3600000, 7 * 60 * 60 * 1000, 2 * 86400000]) assert.equal(isAllowedActivationDuration(durationMs), false);
});
