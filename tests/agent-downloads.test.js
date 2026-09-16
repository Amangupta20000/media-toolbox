import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { normalizeAgentPlatform, selectAgentAsset } from "../lib/agent-downloads.js";

test("installer download selection supports platform aliases and latest asset naming", () => {
  assert.equal(normalizeAgentPlatform("mac"), "macos");
  assert.equal(normalizeAgentPlatform("win32"), "windows");
  assert.equal(normalizeAgentPlatform("linux"), "linux");
  assert.equal(normalizeAgentPlatform("android"), null);

  const assets = [
    { name: "NativeMedia-Agent-1.5.10-arm64.dmg", browser_download_url: "https://example.test/mac.dmg" },
    { name: "NativeMedia-Agent-Setup-1.5.10.exe", browser_download_url: "https://example.test/windows.exe" },
    { name: "NativeMedia-Agent-1.5.10.AppImage", browser_download_url: "https://example.test/linux.AppImage" },
    { name: "NativeMedia-Agent-Setup-1.5.10.exe.blockmap", browser_download_url: "https://example.test/windows.blockmap" },
  ];

  assert.equal(selectAgentAsset(assets, "macos").browser_download_url, "https://example.test/mac.dmg");
  assert.equal(selectAgentAsset(assets, "windows").browser_download_url, "https://example.test/windows.exe");
  assert.equal(selectAgentAsset(assets, "linux").browser_download_url, "https://example.test/linux.AppImage");
  assert.equal(selectAgentAsset(assets, "ios"), null);
});

test("installer redirect endpoints are excluded from search indexing", async () => {
  const route = await fs.readFile(path.resolve("pages/downloads/[platform].js"), "utf8");
  assert.match(route, /X-Robots-Tag/);
  assert.match(route, /noindex, nofollow/);
});
