import assert from "node:assert/strict";
import test from "node:test";
import { formatAccessDuration } from "../lib/access-duration.js";

const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
const day = 24 * hour;

test("formats access time as a compact days, hours, minutes, seconds countdown", () => {
  assert.equal(formatAccessDuration(7 * day + 2 * hour + 4 * minute + 5 * second), "7d 2h 4m 05s");
  assert.equal(formatAccessDuration(90 * minute + 5 * second), "1h 30m 05s");
  assert.equal(formatAccessDuration(65 * second), "1m 05s");
  assert.equal(formatAccessDuration(5 * second), "05s");
});

test("reports expired access for empty, negative, or invalid durations", () => {
  assert.equal(formatAccessDuration(0), "Expired");
  assert.equal(formatAccessDuration(-second), "Expired");
  assert.equal(formatAccessDuration("not a duration"), "Expired");
});
