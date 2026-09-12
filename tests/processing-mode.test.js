import assert from "node:assert/strict";
import test from "node:test";
import { isProcessingLocationReady } from "../components/processing-client.js";

test("an authorized local agent is usable before its browser session exists", () => {
  assert.equal(isProcessingLocationReady({ local: { connected: false, ready: true } }, "local"), true);
});

test("an untrusted or locked local agent is not usable", () => {
  assert.equal(isProcessingLocationReady({ local: { connected: false, ready: false } }, "local"), false);
});
