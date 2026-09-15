import assert from "node:assert/strict";
import test from "node:test";
import { isProcessingLocationReady, preferredProcessingMode } from "../components/processing-client.js";

test("an authorized local agent is usable before its browser session exists", () => {
  assert.equal(isProcessingLocationReady({ local: { available: true, connected: false, ready: true } }, "local"), true);
});

test("an untrusted or locked local agent is not usable", () => {
  assert.equal(isProcessingLocationReady({ local: { available: true, connected: false, ready: false } }, "local"), false);
});

test("processing mode defaults to Local agent, then ready Server mode", () => {
  assert.equal(preferredProcessingMode({ local: { available: true, connected: true }, server: { available: true, connected: true } }), "local");
  assert.equal(preferredProcessingMode({ local: { available: true, connected: false, ready: false }, server: { available: true, connected: true } }), "server");
  assert.equal(preferredProcessingMode({ local: { available: true, connected: false, ready: false }, server: { available: false, connected: false } }), "");
});
