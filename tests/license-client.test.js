import assert from "node:assert/strict";
import test from "node:test";
import { clearAdminToken, storeAdminToken, storedAdminToken } from "../components/license-client.js";

function storage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
  };
}

test("admin token is shared across tabs and expires with the server session", () => {
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  const localStorage = storage();
  const firstTabSessionStorage = storage();
  const secondTabSessionStorage = storage();
  const firstTab = {
    localStorage,
    sessionStorage: firstTabSessionStorage,
    dispatchEvent() {},
  };
  globalThis.window = firstTab;
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) { this.type = type; this.detail = init?.detail; }
  };

  try {
    storeAdminToken("shared-token", Date.now() + 60_000);
    assert.equal(localStorage.getItem("media-toolbox-license-admin-token"), "shared-token");
    assert.equal(storedAdminToken(), "shared-token");

    globalThis.window = { localStorage, sessionStorage: secondTabSessionStorage, dispatchEvent() {} };
    assert.equal(storedAdminToken(), "shared-token", "a second browser tab can see the logged-in admin token");
    localStorage.setItem("media-toolbox-license-admin-token-expires-at", String(Date.now() - 1));
    assert.equal(storedAdminToken(), "", "an expired shared token is not exposed to another tab");

    globalThis.window = firstTab;
    assert.equal(storedAdminToken(), "shared-token", "the original tab can still use its per-tab copy until the server rejects it");
    assert.equal(localStorage.getItem("media-toolbox-license-admin-token"), null, "an expired token is not re-promoted to shared storage");
    firstTabSessionStorage.setItem("media-toolbox-license-admin-token", "legacy-token");
    localStorage.removeItem("media-toolbox-license-admin-token-expires-at");
    assert.equal(storedAdminToken(), "legacy-token");
    assert.equal(localStorage.getItem("media-toolbox-license-admin-token"), "legacy-token", "older per-tab sessions are migrated");
    clearAdminToken();
    assert.equal(storedAdminToken(), "");
  } finally {
    globalThis.window = previousWindow;
    globalThis.CustomEvent = previousCustomEvent;
  }
});
