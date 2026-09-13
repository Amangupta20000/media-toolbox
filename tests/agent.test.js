import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { firstAvailable, runCommand } from "../lib/command.js";

const require = createRequire(import.meta.url);
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "media-toolbox-agent-test-"));
process.env.DATA_DIR = path.join(testRoot, "data");
process.env.MEDIA_TOOLBOX_DOWNLOADS_DIR = path.join(testRoot, "Downloads");
process.env.AGENT_PORT = "0";
const licenseKeys = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
process.env.AGENT_LICENSE_PUBLIC_KEY = licenseKeys.publicKey;
const agent = await import("../agent/server.js");
let server;
let port;
let sessionToken;

before(async () => {
  server = await agent.startAgentServer({ port: 0 });
  port = server.address().port;
});

after(async () => {
  await agent.stopAgentServer();
  await fs.rm(testRoot, { recursive: true, force: true });
});

const url = (pathName) => `http://127.0.0.1:${port}${pathName}`;
const encodeLicensePart = (value) => Buffer.from(value).toString("base64").replace(/=+$/g, "");
const makeActivationCode = ({ deviceId = agent.getDeviceId(), origins = ["http://localhost:3000", "http://127.0.0.1:3000"], issuedAt = Date.now(), durationMs = 10 * 60 * 1000 } = {}) => {
  const payload = { v: 1, licenseId: randomUUID(), origins, issuedAt, durationMs };
  if (deviceId) payload.deviceId = deviceId;
  const payloadText = encodeLicensePart(JSON.stringify(payload));
  const signature = encodeLicensePart(sign(null, Buffer.from(payloadText), licenseKeys.privateKey));
  return `MT1-${`${payloadText}.${signature}`.match(/.{1,4}/g).join("-")}`;
};

test("agent starts a persistent five-minute trial without login or activation", async () => {
  const initialHealth = await fetch(url("/v1/health"), { headers: { Origin: "http://localhost:3000" } });
  const initialState = await initialHealth.json();
  assert.equal(initialState.authorization.mode, "locked");
  assert.equal(initialState.authorization.authorized, false);
  assert.equal(initialState.authorization.legalAccepted, false);
  assert.equal(initialState.authorization.reason, "legal_consent_required");
  assert.equal(initialState.authorization.trialAvailable, true);
  assert.equal(initialState.authorization.trialStartedAt, null);
  assert.equal(initialState.trialAvailable, false);
  assert.throws(() => agent.loginAdmin("Admin", "Aman"), /Privacy Policy|Terms/i);

  const blockedSession = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Before consent" }),
  });
  assert.equal(blockedSession.status, 402);
  assert.equal((await blockedSession.json()).code, "legal_consent_required");

  const accepted = agent.acceptLegal();
  assert.equal(accepted.legalAccepted, true);
  assert.equal(accepted.legalVersion, "1.0.0");
  assert.equal(accepted.mode, "locked");

  // Repeated health checks are discovery only. They must never consume the
  // installation trial or create a browser session.
  const secondHealth = await fetch(url("/v1/health"), { headers: { Origin: "http://localhost:3000" } });
  const secondState = await secondHealth.json();
  assert.equal(secondState.authorization.legalAccepted, true);
  assert.equal(secondState.authorization.trialStartedAt, null);
  assert.equal(secondState.trialAvailable, true);
  assert.equal(secondState.sessionCount, 0);

  const noSessionCapabilities = await fetch(url("/v1/capabilities"), { headers: { Origin: "http://localhost:3000" } });
  assert.equal(noSessionCapabilities.status, 401);

  const sessionResponse = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Trial browser" }),
  });
  assert.equal(sessionResponse.status, 200);
  const trialSession = await sessionResponse.json();
  assert.equal(trialSession.authorization.mode, "trial");
  assert.equal(trialSession.autoPaired, true);
  assert.ok(trialSession.authorization.trialStartedAt);
  assert.equal(trialSession.authorization.trialExpiresAt - trialSession.authorization.trialStartedAt, 5 * 60 * 1000);

  const trialForm = new FormData();
  trialForm.append("tool", "image-converter");
  trialForm.append("format", "png");
  trialForm.append("method", "imagemagick");
  trialForm.append("jpegConfirmed", "false");
  trialForm.append("retention", "delete");
  trialForm.append("source", new Blob([Buffer.from("not a real image")], { type: "image/png" }), "trial.png");
  const trialJobResponse = await fetch(url("/v1/jobs"), {
    method: "POST",
    headers: { Authorization: `Bearer ${trialSession.token}`, Origin: "http://localhost:3000" },
    body: trialForm,
  });
  assert.equal(trialJobResponse.status, 202);
  const trialJob = await trialJobResponse.json();
  assert.ok(trialJob.jobId);

  let terminalJob;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const statusResponse = await fetch(url(`/v1/jobs/${trialJob.jobId}`), { headers: { Authorization: `Bearer ${trialSession.token}`, Origin: "http://localhost:3000" } });
    terminalJob = await statusResponse.json();
    if (["completed", "failed"].includes(terminalJob.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(["completed", "failed"].includes(terminalJob.status));
  const deletedTrialJob = await fetch(url(`/v1/jobs/${trialJob.jobId}`), { method: "DELETE", headers: { Authorization: `Bearer ${trialSession.token}`, Origin: "http://localhost:3000" } });
  assert.equal(deletedTrialJob.status, 200);

  const startedAt = trialSession.authorization.trialStartedAt;
  await agent.stopAgentServer();
  server = await agent.startAgentServer({ port: 0 });
  port = server.address().port;
  const afterRestart = agent.getAgentState().authorization;
  assert.equal(afterRestart.mode, "trial");
  assert.equal(afterRestart.trialStartedAt, startedAt);

  const expired = (await import("../agent/auth.js")).getAuthorizationState(startedAt + 5 * 60 * 1000 + 1);
  assert.equal(expired.mode, "locked");
  assert.equal(expired.reason, "trial_expired");
  const deniedAfterExpiry = (await import("../agent/auth.js")).authorizeProcessing("http://localhost:3000", startedAt + 5 * 60 * 1000 + 1);
  assert.equal(deniedAfterExpiry.ok, false);
  assert.equal(deniedAfterExpiry.code, "activation_required");
});

test("dashboard trial action starts the trial explicitly after legal consent", () => {
  const explicitTrialRoot = path.join(testRoot, "explicit-trial");
  const childScript = `import { acceptLegalConsent, startTrial, getAuthorizationState } from "./agent/auth.js";
acceptLegalConsent();
const state = startTrial();
if (state.mode !== "trial" || !state.trialStartedAt || !state.trialExpiresAt) process.exit(1);
if (getAuthorizationState().trialStartedAt !== state.trialStartedAt) process.exit(1);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    env: {
      ...process.env,
      DATA_DIR: path.join(explicitTrialRoot, "data"),
      MEDIA_TOOLBOX_DOWNLOADS_DIR: path.join(explicitTrialRoot, "Downloads"),
    },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, `The explicit dashboard trial action failed: ${child.stdout}${child.stderr}`);
});

test("dashboard exposes the trial, update, and admin actions in the bottom bar", async () => {
  const dashboardHtml = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "dashboard.html"), "utf8");
  const dashboardCss = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "dashboard.css"), "utf8");
  const dashboardRenderer = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "dashboard-renderer.js"), "utf8");
  const dashboardPreload = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "preload.cjs"), "utf8");
  const agentAuth = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "auth.js"), "utf8");
  const electronMain = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "electron-main.cjs"), "utf8");
  const agentPackage = JSON.parse(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "package.json"), "utf8"));
  const rootPackage = JSON.parse(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));
  const builderConfig = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "electron-builder.yml"), "utf8");
  const updateConfig = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build", "app-update.yml"), "utf8");
  const releaseWorkflow = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "agent-release.yml"), "utf8");
  assert.match(dashboardHtml, /id="start-trial-button"/);
  assert.match(dashboardHtml, /id="authorization-panel" class="panel authorization-panel"/);
  assert.doesNotMatch(dashboardHtml, /Authorize processing/);
  assert.doesNotMatch(dashboardHtml, /class="divider"/);
  assert.doesNotMatch(dashboardHtml, /Device details/);
  assert.doesNotMatch(dashboardHtml, /class="panel device-panel"|id="trusted-origins"|id="agent-version"|id="protocol"/);
  assert.doesNotMatch(dashboardHtml, /id="device-id"/);
  assert.match(dashboardHtml, /id="locked-help" class="locked-help hidden"/);
  assert.match(dashboardHtml, /id="admin-control-button"/);
  assert.match(dashboardHtml, /id="check-updates-bottom"/);
  assert.match(dashboardHtml, /id="start-license-server"/);
  assert.match(dashboardHtml, /id="check-license-server"/);
  assert.match(dashboardHtml, /id="license-server-panel" class="panel license-server-panel hidden"/);
  assert.match(dashboardHtml, /id="license-server-notice"/);
  assert.match(dashboardHtml, /id="license-server-command"/);
  assert.match(dashboardHtml, /id="copy-license-server-command"/);
  assert.match(dashboardHtml, /id="license-server-tailscale-status"/);
  assert.match(dashboardHtml, /Copy this command only when using a source checkout/);
  assert.doesNotMatch(dashboardHtml, /bottom-left/);
  assert.match(dashboardRenderer, /el\("authorization-panel"\)\.classList\.toggle\("hidden", mode === "admin"\)/);
  assert.match(dashboardRenderer, /status-running/);
  assert.match(dashboardRenderer, /status-stopped/);
  assert.match(dashboardCss, /\.dashboard-actions\{position:fixed;left:0;right:0;bottom:0/);
  assert.match(dashboardCss, /\.authorization-panel\{grid-column:1 \/ -1\}/);
  assert.match(dashboardCss, /\.license-owner-panel\{margin-top:18px\}/);
  assert.match(dashboardCss, /\.pill\.status-running::before/);
  assert.match(dashboardCss, /@keyframes agent-status-live/);
  assert.match(dashboardCss, /@keyframes agent-status-alert/);
  assert.match(dashboardCss, /prefers-reduced-motion:reduce/);
  assert.match(dashboardCss, /\.admin-action\{background:#102c3d;border:1px solid/);
  assert.match(dashboardPreload, /agent:start-license-server/);
  assert.match(dashboardPreload, /agent:get-license-server-state/);
  assert.match(electronMain, /licenseServerManager\.watchForStorage/);
  assert.match(electronMain, /ensureOwnerLicenseServer/);
  assert.match(electronMain, /state\.ownerConfigured && !state\.healthy/);
  assert.match(electronMain, /licenseServerManager\?\.stopWatching/);
  assert.match(dashboardPreload, /agent:login-activation/);
  assert.match(dashboardPreload, /agent:logout-activation/);
  assert.match(dashboardPreload, /agent:run-diagnostics/);
  assert.match(dashboardPreload, /agent:open-results-folder/);
  assert.match(dashboardPreload, /agent:get-update-state/);
  assert.match(dashboardPreload, /agent:check-for-updates/);
  assert.match(dashboardPreload, /agent:download-update/);
  assert.match(dashboardPreload, /agent:install-update/);
  assert.match(dashboardPreload, /agent:open-release-page/);
  assert.match(dashboardRenderer, /currentState\?\.authorization\?\.mode === "admin"/);
  assert.match(dashboardRenderer, /el\("locked-help"\)\.classList\.toggle\("hidden"/);
  assert.doesNotMatch(dashboardRenderer, /copyDeviceId/);
  assert.doesNotMatch(dashboardPreload, /copy-device-id/);
  assert.match(dashboardRenderer, /el\("run-self-test"\)/);
  assert.match(dashboardHtml, /id="agent-update-panel"/);
  assert.match(dashboardRenderer, /Restart and install/);
  assert.match(dashboardRenderer, /status === "up-to-date"/);
  assert.match(dashboardRenderer, /Agent is up to date/);
  assert.doesNotMatch(dashboardRenderer, /showNotice\([^\n]*up to date/);
  assert.match(dashboardRenderer, /updateDismissTimer/);
  assert.match(dashboardRenderer, /window\.setTimeout\(\(\) => \{[\s\S]*panel\.classList\.add\("hidden"\)[\s\S]*\}, 10000\)/);
  assert.match(dashboardRenderer, /full-required/);
  assert.match(dashboardRenderer, /Full agent update required/);
  assert.match(dashboardRenderer, /update-full-required/);
  assert.match(dashboardRenderer, /downloadUpdate/);
  assert.match(dashboardRenderer, /open-release/);
  assert.match(dashboardRenderer, /Update manually from GitHub Releases/);
  assert.match(electronMain, /hasDeveloperIdSignature/);
  assert.match(electronMain, /net\.fetch/);
  assert.match(electronMain, /checkPublicLicenseServer/);
  assert.match(electronMain, /globalThis\.fetch = net\.fetch\.bind\(net\)/);
  assert.match(electronMain, /setLicenseServerFetchImplementation/);
  assert.match(electronMain, /checkForRuntimeUpdates/);
  assert.match(electronMain, /fullInstallerMessage/);
  assert.match(electronMain, /updateType: "full"/);
  assert.match(electronMain, /readInstalledRuntime/);
  assert.match(electronMain, /compareVersions\(app\.getVersion\(\), installedRuntime\.manifest\.version\)/);
  assert.match(electronMain, /pathToFileURL/);
  assert.match(dashboardRenderer, /check-updates-bottom/);
  assert.match(builderConfig, /provider: github/);
  assert.match(builderConfig, /to: app-update\.yml/);
  assert.match(updateConfig, /repo: media-toolbox/);
  assert.match(releaseWorkflow, /-name 'latest\*\.yml'/);
  assert.match(releaseWorkflow, /-name '\*\.blockmap'/);
  assert.match(releaseWorkflow, /Cache Electron packaging downloads/);
  assert.match(releaseWorkflow, /electron-builder-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-node22-/);
  assert.match(releaseWorkflow, /~\/\.cache\/electron-builder/);
  assert.match(releaseWorkflow, /cache-dependency-path: agent\/package-lock\.json/);
  assert.match(releaseWorkflow, /hashFiles\('agent\/package-lock\.json', 'electron-builder\.yml'\)/);
  assert.match(releaseWorkflow, /Stage agent-only packaging directory/);
  assert.match(releaseWorkflow, /node scripts\/stage-agent-package\.mjs/);
  assert.match(releaseWorkflow, /Verify embedded licensing configuration/);
  assert.match(builderConfig, /agent\/license-server-url\.txt/);
  assert.match(releaseWorkflow, /working-directory: \.agent-build/);
  assert.match(releaseWorkflow, /npm ci --prefer-offline --no-audit --no-fund/);
  assert.doesNotMatch(releaseWorkflow, /npm ci --legacy-peer-deps --prefer-offline --no-audit --no-fund/);
  assert.match(releaseWorkflow, /Cache rebuilt agent-only dependencies/);
  assert.match(releaseWorkflow, /agent-deps-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-node22-electron37\.10\.3-abi136-/);
  assert.match(releaseWorkflow, /electron-rebuild --version 37\.10\.3 --parallel/);
  assert.match(rootPackage.scripts["agent:package"], /package-agent\.mjs/);
  assert.match(builderConfig, /nativeRebuilder: parallel/);
  assert.match(builderConfig, /npmRebuild: false/);
  assert.doesNotMatch(releaseWorkflow, /linux-target:/);
  assert.match(releaseWorkflow, /--linux AppImage deb --publish never/);
  assert.match(releaseWorkflow, /find \.agent-build\/release -maxdepth 1/);
  assert.match(releaseWorkflow, /Embed runtime update public key/);
  assert.match(releaseWorkflow, /Package signed agent runtime update/);
  assert.match(releaseWorkflow, /AGENT_RUNTIME_UPDATE_PUBLIC_KEY/);
  assert.match(releaseWorkflow, /AGENT_RUNTIME_UPDATE_PRIVATE_KEY/);
  assert.match(releaseWorkflow, /agent-runtime-manifest-\*\.json/);
  assert.match(releaseWorkflow, /name: media-toolbox-agent-\$\{\{ matrix\.artifact \}\}/);
  assert.match(await fs.readFile(path.join(projectDirectory, "scripts/package-agent-runtime.mjs"), "utf8"), /public\/fonts/);
  assert.match(await fs.readFile(path.join(projectDirectory, "electron-builder.yml"), "utf8"), /public\/fonts\/\*\*\/\*/);
  assert.deepEqual(Object.keys(agentPackage.dependencies).sort(), ["@ffmpeg-installer/ffmpeg", "@ffprobe-installer/ffprobe", "@napi-rs/canvas", "@pdf-lib/standard-fonts", "@tesseract.js-data/eng", "@tesseract.js-data/hin", "better-sqlite3", "busboy", "electron-updater", "fontkit", "pdf-lib", "pdfjs-dist", "selfsigned", "sharp", "tesseract.js"]);
  assert.equal(agentPackage.dependencies.next, undefined);
  assert.equal(agentPackage.dependencies.react, undefined);
  assert.equal(agentPackage.dependencies["pdfjs-dist"], "^6.3.289");
  assert.match(dashboardRenderer, /setLicenseServerNotice/);
  assert.match(dashboardRenderer, /LICENSE_DATA_DIR=\$\{shellQuote\(dataDir\)\} npm run license-server/);
  assert.match(dashboardRenderer, /copy-license-server-command/);
  assert.match(dashboardRenderer, /Tailscale was closed, so it was opened/);
  assert.match(dashboardRenderer, /value\.ownerConfigured === true/);
  assert.match(dashboardRenderer, /panel\.classList\.toggle\("hidden", !adminAuthenticated\)/);
  assert.match(dashboardRenderer, /state\.authorization\?\.mode === "admin"/);
  assert.match(dashboardRenderer, /stopButton\.textContent = managedByAgent \? "Stop server" : "Stop unavailable"/);
  assert.match(dashboardRenderer, /started outside this agent/);
  assert.match(electronMain, /installedRuntimeDirectory/);
  assert.match(electronMain, /dashboardDirectory/);
  assert.match(electronMain, /preload: path\.join\(dashboardDirectory, "preload\.cjs"\)/);
  assert.match(electronMain, /loadFile\(path\.join\(dashboardDirectory, "dashboard\.html"\)\)/);
  assert.match(electronMain, /movable: true/);
  assert.match(electronMain, /titleBarStyle: "default"/);
  assert.match(electronMain, /Menu\.setApplicationMenu/);
  assert.match(electronMain, /label: app\.name/);
  assert.doesNotMatch(electronMain, /app\.dock\?\.hide/);
  assert.match(dashboardRenderer, /block\.classList\.toggle\("hidden", mode === "activation"\)/);
  assert.match(dashboardHtml, /id="activation-session-access"/);
  assert.match(dashboardRenderer, /activationReloginAvailable/);
  assert.match(dashboardRenderer, /render\(await api\.logout\(\)\); closeAdminModal\(\); showNotice\(""\);/);
  assert.match(dashboardHtml, /id="timer-info"/);
  assert.match(dashboardHtml, /id="original-countdown"/);
  assert.match(dashboardHtml, /two-thirds of the current original remaining time/);
  assert.match(dashboardRenderer, /activationSessionLimitReached/);
  assert.match(dashboardHtml, /id="refresh-sessions"/);
  assert.match(dashboardRenderer, /Connected sessions refreshed\./);
  assert.match(builderConfig, /from: license-server\n    to: license-server/);
  assert.match(agentAuth, /from "\.\/token\.js"/);
  assert.match(builderConfig, /- agent\/\*\*\/\*/);
  assert.match(builderConfig, /from: lib\/token\.js\n    to: lib\/token\.js/);
  assert.match(builderConfig, /from: node_modules\/better-sqlite3\n    to: node_modules\/better-sqlite3/);
  assert.match(builderConfig, /from: node_modules\/bindings\n    to: node_modules\/bindings/);
  assert.match(builderConfig, /from: node_modules\/file-uri-to-path\n    to: node_modules\/file-uri-to-path/);
  assert.equal((dashboardHtml.match(/data-license-duration=/g) || []).length, 5);
  assert.match(dashboardHtml, /id="license-owner-panel"/);
  assert.match(dashboardHtml, /id="license-audit-panel"/);
  assert.match(dashboardHtml, /id="refresh-license-audit"/);
  assert.match(dashboardPreload, /agent:get-license-audit/);
  assert.match(dashboardRenderer, /license-audit-events/);
  assert.match(dashboardRenderer, /api\.getLicenseAudit/);
  assert.doesNotMatch(dashboardHtml, /bottom-left/);
});

test("agent self-test covers connectivity, storage, and every media capability", async () => {
  const diagnostics = await agent.runDiagnostics();
  assert.equal(diagnostics.ok, true);
  assert.ok(diagnostics.checkedAt);
  assert.deepEqual(
    diagnostics.items.map((item) => item.id),
    ["agent", "permissions", "disk", "ffmpeg", "imagemagick", "heic", "mkv", "untrunc"],
  );
  assert.ok(diagnostics.items.every((item) => ["pass", "warn", "fail"].includes(item.status)));
  assert.equal(diagnostics.capabilities.agentVersion, "0.2.1");
});

test("history and protected PDF flows expose the new safe controls", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const history = await fs.readFile(path.join(root, "components", "tool-history.jsx"), "utf8");
  const pdfEditor = await fs.readFile(path.join(root, "components", "pdf-editor.jsx"), "utf8");
  const styles = await fs.readFile(path.join(root, "styles", "globals.css"), "utf8");
  const worker = await fs.readFile(path.join(root, "worker", "index.js"), "utf8");
  assert.match(history, /Open Results folder/);
  assert.match(history, /type="search"/);
  assert.match(history, /File size/);
  assert.match(history, /Duration/);
  assert.match(history, /history-status-badge/);
  assert.match(pdfEditor, /task\.onPassword/);
  assert.match(pdfEditor, /window\.prompt/);
  assert.match(pdfEditor, /kind: loaded\.passwordProtected \? "raster" : "source"/);
  assert.match(pdfEditor, /rotateSelectedPage/);
  assert.match(pdfEditor, /duplicateSelectedPage/);
  assert.match(pdfEditor, /previewZoom/);
  assert.match(pdfEditor, /validatePdfProject/);
  assert.match(pdfEditor, /Keyboard/);
  assert.match(pdfEditor, /Export validation failed/);
  assert.match(styles, /\.pdf-image-overlay-layer \{[^}]*overflow: visible/);
  assert.match(styles, /\.pdf-page-canvas-wrap \{[^}]*overflow: auto/);
  assert.match(worker, /referencedPdfIndices/);
  assert.match(worker, /copiedPage\.setRotation/);
});

test("dashboard licensing server manager starts and stops the loopback service", async () => {
  const { createLicenseServerManager } = require("../agent/license-server-manager.cjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryMount = path.join(testRoot, "license-server-manager");
  const dataDirectory = path.join(temporaryMount, "MediaToolboxLicensing");
  let healthy = false;
  let spawned = null;
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    healthy = false;
    child.emit("exit", 0, "SIGTERM");
  };
  const manager = createLicenseServerManager({
    moduleDirectory: path.join(root, "agent"),
    dataDirectory,
    mountPath: temporaryMount,
    nodeExecutable: "/node22/bin/node",
    existsSync: (value) => value === temporaryMount || value === dataDirectory || value.endsWith(path.join("license-server", "index.js")),
    healthCheck: async () => healthy,
    spawnImpl: (command, args, options) => {
      spawned = { command, args, options };
      healthy = true;
      return child;
    },
    logger: { log() {}, warn() {} },
  });
  const started = await manager.start();
  assert.equal(started.healthy, true);
  assert.equal(started.started, true);
  assert.equal(spawned.command, "/node22/bin/node");
  assert.match(spawned.args[0], /license-server[\\/]index\.js$/);
  assert.equal(spawned.options.env.LICENSE_DATA_DIR, dataDirectory);
  assert.equal(spawned.options.env.LICENSE_SERVER_PORT, "4900");
  const stopped = await manager.stop();
  assert.equal(stopped.healthy, false);
  assert.equal(stopped.managed, false);
});

test("dashboard licensing server manager opens Tailscale before starting when the app is closed", async () => {
  const { createLicenseServerManager } = require("../agent/license-server-manager.cjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const mountPath = path.join(testRoot, "license-server-tailscale");
  const dataDirectory = path.join(mountPath, "MediaToolboxLicensing");
  let healthy = false;
  let opened = 0;
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    healthy = false;
    child.emit("exit", 0, "SIGTERM");
  };
  const manager = createLicenseServerManager({
    moduleDirectory: path.join(root, "agent"),
    dataDirectory,
    mountPath,
    nodeExecutable: "/node22/bin/node",
    platform: "darwin",
    tailscaleAppPath: "/Applications/Tailscale.app",
    tailscaleRunningCheck: async () => false,
    tailscaleOpen: async () => { opened += 1; },
    existsSync: (value) => value === mountPath || value === dataDirectory || value === "/Applications/Tailscale.app" || value.endsWith(path.join("license-server", "index.js")),
    healthCheck: async () => healthy,
    spawnImpl: () => {
      healthy = true;
      return child;
    },
    logger: { log() {}, warn() {} },
  });
  const started = await manager.start();
  assert.equal(opened, 1);
  assert.equal(started.tailscale.opened, true);
  assert.match(started.tailscale.message, /Tailscale was closed/);
  assert.equal(started.started, true);
  await manager.stop();
});

test("packaged licensing server manager uses a real cwd and can restart after stopping", async () => {
  const { createLicenseServerManager } = require("../agent/license-server-manager.cjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryMount = path.join(testRoot, "packaged-license-server-manager");
  const resourcesPath = path.join(testRoot, "electron-resources");
  await fs.mkdir(resourcesPath, { recursive: true });
  let healthy = false;
  let spawned = [];
  const manager = createLicenseServerManager({
    moduleDirectory: path.join(resourcesPath, "app.asar", "agent"),
    resourcesPath,
    dataDirectory: path.join(temporaryMount, "MediaToolboxLicensing"),
    mountPath: temporaryMount,
    electronExecutable: "/Applications/Media Toolbox Agent.app/Contents/MacOS/Media Toolbox Agent",
    useElectronRuntime: true,
    existsSync: (value) => value === temporaryMount || value === resourcesPath || value.endsWith(path.join("license-server", "index.js")),
    healthCheck: async () => healthy,
    spawnImpl: (command, args, options) => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        child.exitCode = 0;
        healthy = false;
        child.emit("exit", 0, "SIGTERM");
      };
      spawned.push({ command, args, options });
      healthy = true;
      return child;
    },
    logger: { log() {}, warn() {} },
  });
  const first = await manager.start();
  assert.equal(first.started, true);
  assert.equal(spawned[0].args[0], path.join(resourcesPath, "license-server", "index.js"));
  assert.equal(spawned[0].options.cwd, resourcesPath);
  assert.equal(spawned[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(
    spawned[0].options.env.NODE_PATH,
    [
      path.join(resourcesPath, "node_modules"),
      path.join(resourcesPath, "app.asar.unpacked", "node_modules"),
    ].join(path.delimiter),
  );
  await manager.stop();
  const second = await manager.start();
  assert.equal(second.started, true);
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].options.cwd, resourcesPath);
  await manager.stop();
});

test("licensing server manager starts automatically when the SSD is mounted", async () => {
  const { createLicenseServerManager } = require("../agent/license-server-manager.cjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const mountPath = path.join(testRoot, "auto-start-mounted-ssd");
  const dataDirectory = path.join(mountPath, "MediaToolboxLicensing");
  let healthy = false;
  let spawned = 0;
  const manager = createLicenseServerManager({
    moduleDirectory: path.join(root, "agent"),
    dataDirectory,
    mountPath,
    nodeExecutable: "/node22/bin/node",
    autoStartIntervalMs: 10,
    existsSync: (value) => value === mountPath || value === dataDirectory || value.endsWith(path.join("license-server", "index.js")),
    healthCheck: async () => healthy,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { child.killed = true; child.exitCode = 0; healthy = false; child.emit("exit", 0, "SIGTERM"); };
      spawned += 1;
      healthy = true;
      return child;
    },
    logger: { log() {}, warn() {} },
  });
  try {
    const state = await manager.watchForStorage();
    assert.equal(state.healthy, true);
    assert.equal(state.autoStartStatus, "running");
    assert.equal(spawned, 1);
  } finally {
    manager.stopWatching();
    await manager.stop();
  }
});

test("licensing server manager waits for the SSD and starts after it appears", async () => {
  const { createLicenseServerManager } = require("../agent/license-server-manager.cjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const mountPath = path.join(testRoot, "auto-start-later-ssd");
  const dataDirectory = path.join(mountPath, "MediaToolboxLicensing");
  let mounted = false;
  let healthy = false;
  const manager = createLicenseServerManager({
    moduleDirectory: path.join(root, "agent"),
    dataDirectory,
    mountPath,
    nodeExecutable: "/node22/bin/node",
    autoStartIntervalMs: 10,
    existsSync: (value) => (value === mountPath ? mounted : value === dataDirectory || value.endsWith(path.join("license-server", "index.js"))),
    healthCheck: async () => healthy,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { child.killed = true; child.exitCode = 0; healthy = false; child.emit("exit", 0, "SIGTERM"); };
      healthy = true;
      return child;
    },
    logger: { log() {}, warn() {} },
  });
  try {
    const waiting = await manager.watchForStorage();
    assert.equal(waiting.healthy, false);
    assert.equal(waiting.autoStartStatus, "waiting-for-ssd");
    mounted = true;
    for (let attempt = 0; attempt < 20 && !healthy; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(healthy, true);
    assert.equal((await manager.getState()).autoStartStatus, "running");
  } finally {
    manager.stopWatching();
    await manager.stop();
  }
});

test("manual licensing-server stop suppresses automatic restart until explicitly started", async () => {
  const { createLicenseServerManager } = require("../agent/license-server-manager.cjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const mountPath = path.join(testRoot, "auto-start-manual-stop");
  let healthy = false;
  let spawned = 0;
  const manager = createLicenseServerManager({
    moduleDirectory: path.join(root, "agent"),
    mountPath,
    nodeExecutable: "/node22/bin/node",
    autoStartIntervalMs: 10,
    existsSync: (value) => value === mountPath || value.endsWith(path.join("license-server", "index.js")),
    healthCheck: async () => healthy,
    spawnImpl: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { child.killed = true; child.exitCode = 0; healthy = false; child.emit("exit", 0, "SIGTERM"); };
      spawned += 1;
      healthy = true;
      return child;
    },
    logger: { log() {}, warn() {} },
  });
  try {
    await manager.watchForStorage();
    await manager.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spawned, 1);
    assert.equal((await manager.getState()).autoStartStatus, "stopped");
    await manager.start();
    assert.equal(spawned, 2);
  } finally {
    manager.stopWatching();
    await manager.stop();
  }
});

test("dashboard licensing server manager reports local and public health separately", async () => {
  const { createLicenseServerManager } = require("../agent/license-server-manager.cjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const temporaryMount = path.join(testRoot, "license-server-public-health");
  const dataDirectory = path.join(temporaryMount, "MediaToolboxLicensing");
  const previousPublicUrl = process.env.LICENSE_SERVER_PUBLIC_URL;
  process.env.LICENSE_SERVER_PUBLIC_URL = "https://license.example.test";
  const checkedUrls = [];
  try {
    const manager = createLicenseServerManager({
      moduleDirectory: path.join(root, "agent"),
      dataDirectory,
      mountPath: temporaryMount,
      existsSync: (value) => value === temporaryMount || value === dataDirectory || value.endsWith(path.join("license-server", "index.js")),
      healthCheck: async (value) => {
        checkedUrls.push(value);
        return value === "http://127.0.0.1:4900/v1/health";
      },
      publicHealthCheck: async (value) => {
        checkedUrls.push(value);
        return false;
      },
    });
    const state = await manager.getState();
    assert.equal(state.healthy, true);
    assert.equal(state.publicHealthy, false);
    assert.match(state.error, /public HTTPS endpoint could not be reached/i);
    assert.deepEqual(checkedUrls.sort(), ["http://127.0.0.1:4900/v1/health", "https://license.example.test/v1/health"]);
  } finally {
    if (previousPublicUrl === undefined) delete process.env.LICENSE_SERVER_PUBLIC_URL;
    else process.env.LICENSE_SERVER_PUBLIC_URL = previousPublicUrl;
  }
});

test("client licensing status can use the website fallback when direct HTTPS is unavailable", async () => {
  const { createLicenseServerManager } = require("../agent/license-server-manager.cjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manager = createLicenseServerManager({
    moduleDirectory: path.join(root, "agent"),
    dataDirectory: path.join(testRoot, "client-fallback-data"),
    mountPath: path.join(testRoot, "missing-client-fallback-ssd"),
    publicHealthCheck: async (value) => {
      assert.equal(value, "https://license.example.test/v1/health");
      return false;
    },
    publicProxyUrl: "https://media-toolbox-woad.vercel.app/api/license",
    publicProxyHealthCheck: async (value) => value === "https://media-toolbox-woad.vercel.app/api/license/v1/health",
    existsSync: (value) => value.endsWith(path.join("license-server", "index.js")),
    healthCheck: async () => false,
  });
  const previousPublicUrl = process.env.LICENSE_SERVER_PUBLIC_URL;
  process.env.LICENSE_SERVER_PUBLIC_URL = "https://license.example.test";
  try {
    const state = await manager.getState();
    assert.equal(state.ownerConfigured, false);
    assert.equal(state.publicHealthy, true);
    assert.equal(state.publicHealthSource, "website-proxy");
  } finally {
    if (previousPublicUrl === undefined) delete process.env.LICENSE_SERVER_PUBLIC_URL;
    else process.env.LICENSE_SERVER_PUBLIC_URL = previousPublicUrl;
  }
});

test("packaged licensing-server manager reads the embedded public URL", async () => {
  const { createLicenseServerManager } = require("../agent/license-server-manager.cjs");
  const moduleDirectory = path.join(testRoot, "packaged-agent");
  const previousPackagedConfig = process.env.AGENT_PACKAGED_CONFIG;
  process.env.AGENT_PACKAGED_CONFIG = "1";
  await fs.mkdir(moduleDirectory, { recursive: true });
  await fs.writeFile(path.join(moduleDirectory, "license-server-url.txt"), "https://media-toolbox-license.example\n");
  try {
    const manager = createLicenseServerManager({
      moduleDirectory,
      dataDirectory: path.join(testRoot, "packaged-license-data"),
      mountPath: path.join(testRoot, "missing-packaged-ssd"),
      existsSync: (value) => value.endsWith(path.join("license-server", "index.js")),
      healthCheck: async () => false,
      publicHealthCheck: async (value) => value === "https://media-toolbox-license.example/v1/health",
    });
    const state = await manager.getState();
    assert.equal(state.publicUrl, "https://media-toolbox-license.example");
    assert.equal(state.publicHealthy, true);
  } finally {
    if (previousPackagedConfig === undefined) delete process.env.AGENT_PACKAGED_CONFIG;
    else process.env.AGENT_PACKAGED_CONFIG = previousPackagedConfig;
  }
});

test("client installations do not advertise the owner-only SSD licensing server", async () => {
  const { createLicenseServerManager } = require("../agent/license-server-manager.cjs");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manager = createLicenseServerManager({
    moduleDirectory: path.join(root, "agent"),
    dataDirectory: path.join(testRoot, "client-license-data"),
    mountPath: path.join(testRoot, "missing-licensing-ssd"),
    existsSync: (value) => value.endsWith(path.join("license-server", "index.js")),
    healthCheck: async () => false,
  });
  const state = await manager.getState();
  assert.equal(state.ownerConfigured, false);
  assert.equal(state.error, "");
});

test("Admin dashboard shows licensing-server status on non-owner installations without enabling SSD controls", async () => {
  const source = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent", "dashboard-renderer.js"), "utf8");
  assert.match(source, /panel\.classList\.toggle\("hidden", !visible\)/);
  assert.match(source, /Online licensing connected/);
  assert.match(source, /website fallback/);
  assert.match(source, /Not applicable/);
  assert.match(source, /!ownerMachine \|\| !mounted/);
});

test("website local-agent setup does not expose license-request controls", async () => {
  const source = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "components", "local-agent-setup.jsx"), "utf8");
  assert.doesNotMatch(source, /createLicenseRequest|getLicenseRequest|license-request-box|Request activation/);
  assert.match(source, /request a code.*desktop dashboard|request a code.*desktop/i);
});

test("website local-agent setup keeps Windows and Linux installers disabled", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = await fs.readFile(path.join(root, "components", "local-agent-setup.jsx"), "utf8");
  const styles = await fs.readFile(path.join(root, "styles", "globals.css"), "utf8");
  assert.match(source, /macOS available/);
  assert.match(source, /agent-platform-disabled" type="button" disabled[^>]*>.*Windows installer/);
  assert.match(source, /agent-platform-disabled" type="button" disabled[^>]*>.*Linux installer/);
  assert.match(source, /Windows and Linux installers will be available in a future release/);
  assert.match(styles, /\.agent-platform-disabled[^}]*cursor: not-allowed/);
});

test("web admin panel uses the hidden /admin route and is not in navigation", async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const adminPage = await fs.readFile(path.join(root, "pages", "admin.jsx"), "utf8");
  const shell = await fs.readFile(path.join(root, "components", "app-shell.jsx"), "utf8");
  assert.match(adminPage, /LicenseAdmin/);
  assert.doesNotMatch(shell, /href:\s*["']\/license-admin["']/);
  assert.doesNotMatch(shell, /label:\s*["']Licensing admin["']/);
});

test("desktop dashboard can request and poll an online activation code", async () => {
  const auth = await import("../agent/auth.js");
  const previousServerUrl = process.env.AGENT_LICENSE_SERVER_URL;
  const previousLocalServerUrl = process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    if (request.method === "POST" && request.url === "/v1/license-requests") {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { origin: "http://localhost:3000", requesterLabel: "Local agent dashboard", durationMs: 7200000 });
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ requestId: "dashboard-request", requestToken: "request-secret", status: "pending", origin: "http://localhost:3000" }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/license-requests/dashboard-request") {
      assert.equal(request.headers["x-request-token"], "request-secret");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ id: "dashboard-request", status: "approved", origin: "http://localhost:3000", code: "MT1-approved-dashboard-code" }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/admin/login") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true, token: "dashboard-admin-token" }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/admin/license-requests") {
      assert.equal(request.headers.authorization, "Bearer dashboard-admin-token");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ items: [{ id: "owner-request", status: "pending", durationMs: 86400000, origin: "http://localhost:3000" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/admin/logout") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    // Local development must prefer the loopback licensing service because a
    // machine cannot always hairpin back through its own public Funnel URL.
    process.env.AGENT_LICENSE_SERVER_URL = "http://127.0.0.1:1";
    process.env.AGENT_LICENSE_SERVER_LOCAL_URL = `http://127.0.0.1:${server.address().port}`;
    const config = auth.getLicenseRequestConfig();
    assert.equal(config.available, true);
    assert.equal(config.localServerUrl, `http://127.0.0.1:${server.address().port}`);
    assert.ok(config.suggestedOrigins.includes("https://media-toolbox-woad.vercel.app"));
    assert.deepEqual(config.allowedDurations.map(({ value }) => value), ["10m", "30m", "2h", "6h", "1d"]);
    const created = await auth.requestActivationCode("http://localhost:3000", "Local agent dashboard", 7200000);
    assert.equal(created.status, "pending");
    const approved = await auth.getActivationRequestStatus(created.requestId, created.requestToken);
    assert.equal(approved.status, "approved");
    assert.equal(approved.code, "MT1-approved-dashboard-code");
    const adminSession = await auth.loginLicenseAdmin("Admin", "Aman");
    assert.deepEqual(adminSession, { authenticated: true });
    const ownerRequests = await auth.getLicenseAdminRequests();
    assert.equal(ownerRequests.items[0].durationMs, 86400000);
    await auth.logoutLicenseAdmin();
    assert.equal(requests.length, 5);
  } finally {
    if (previousServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_URL;
    else process.env.AGENT_LICENSE_SERVER_URL = previousServerUrl;
    if (previousLocalServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
    else process.env.AGENT_LICENSE_SERVER_LOCAL_URL = previousLocalServerUrl;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("desktop dashboard restores its licensing Admin session after a runtime restart", async () => {
  const auth = await import("../agent/auth.js");
  const restartedAuth = await import(`../agent/auth.js?restart=${randomUUID()}`);
  const previousServerUrl = process.env.AGENT_LICENSE_SERVER_URL;
  const previousLocalServerUrl = process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization || "" });
    response.setHeader("Content-Type", "application/json");
    if (request.method === "POST" && request.url === "/v1/admin/login") {
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, token: "persisted-dashboard-admin-token", expiresAt: Date.now() + 60 * 60 * 1000 }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/admin/license-requests") {
      assert.equal(request.headers.authorization, "Bearer persisted-dashboard-admin-token");
      response.writeHead(200);
      response.end(JSON.stringify({ items: [{ id: "persisted-request", status: "pending" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/admin/logout") {
      assert.equal(request.headers.authorization, "Bearer persisted-dashboard-admin-token");
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    process.env.AGENT_LICENSE_SERVER_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
    await auth.loginLicenseAdmin("Admin", "Aman");
    assert.deepEqual(restartedAuth.getLicenseAdminState(), { authenticated: true });
    const ownerRequests = await restartedAuth.getLicenseAdminRequests();
    assert.equal(ownerRequests.items[0].id, "persisted-request");
    await restartedAuth.logoutLicenseAdmin();
    // The first module represents the pre-restart process. Clear its in-memory
    // copy too so the shared test process cannot retain a stale bearer token.
    await auth.logoutLicenseAdmin();
    assert.deepEqual(restartedAuth.getLicenseAdminState(), { authenticated: false });
    assert.deepEqual(requests.map(({ method, url }) => ({ method, url })), [
      { method: "POST", url: "/v1/admin/login" },
      { method: "GET", url: "/v1/admin/license-requests" },
      { method: "POST", url: "/v1/admin/logout" },
      { method: "POST", url: "/v1/admin/logout" },
    ]);
  } finally {
    if (previousServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_URL;
    else process.env.AGENT_LICENSE_SERVER_URL = previousServerUrl;
    if (previousLocalServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
    else process.env.AGENT_LICENSE_SERVER_LOCAL_URL = previousLocalServerUrl;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("online licensing configuration supports a local-first fallback", async () => {
  const auth = await import("../agent/auth.js");
  const previousServerUrl = process.env.AGENT_LICENSE_SERVER_URL;
  const previousLocalServerUrl = process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
  try {
    process.env.AGENT_LICENSE_SERVER_URL = "https://media-toolbox-license.tailf9a730.ts.net";
    process.env.AGENT_LICENSE_SERVER_LOCAL_URL = "http://127.0.0.1:4900";
    const config = auth.getLicenseRequestConfig();
    assert.equal(config.available, true);
    assert.equal(config.localServerUrl, "http://127.0.0.1:4900");
    assert.equal(config.serverUrl, "https://media-toolbox-license.tailf9a730.ts.net");
  } finally {
    if (previousServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_URL;
    else process.env.AGENT_LICENSE_SERVER_URL = previousServerUrl;
    if (previousLocalServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
    else process.env.AGENT_LICENSE_SERVER_LOCAL_URL = previousLocalServerUrl;
  }
});

test("licensing requests can use Electron's browser-compatible network client", async () => {
  const auth = await import("../agent/auth.js");
  const previousServerUrl = process.env.AGENT_LICENSE_SERVER_URL;
  const previousLocalServerUrl = process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
  let calls = 0;
  try {
    process.env.AGENT_LICENSE_SERVER_URL = "https://media-toolbox-license.tailf9a730.ts.net";
    delete process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
    auth.setLicenseServerFetchImplementation(async (requestUrl, options) => {
      calls += 1;
      assert.equal(requestUrl, "https://media-toolbox-license.tailf9a730.ts.net/v1/license-requests/request-1");
      assert.equal(options.headers["X-Request-Token"], "request-token");
      return new Response(JSON.stringify({ status: "pending" }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const result = await auth.getActivationRequestStatus("request-1", "request-token");
    assert.deepEqual(result, { status: "pending" });
    assert.equal(calls, 1);
  } finally {
    auth.setLicenseServerFetchImplementation(globalThis.fetch.bind(globalThis));
    if (previousServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_URL;
    else process.env.AGENT_LICENSE_SERVER_URL = previousServerUrl;
    if (previousLocalServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
    else process.env.AGENT_LICENSE_SERVER_LOCAL_URL = previousLocalServerUrl;
  }
});

test("online licensing falls back to the website proxy on a client laptop", async () => {
  const auth = await import("../agent/auth.js");
  const previousServerUrl = process.env.AGENT_LICENSE_SERVER_URL;
  const previousLocalServerUrl = process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
  const previousProxyUrl = process.env.AGENT_LICENSE_SERVER_PROXY_URL;
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/license-requests/fallback-request");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ status: "pending" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    process.env.AGENT_LICENSE_SERVER_URL = "https://license-unreachable.invalid";
    delete process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
    process.env.AGENT_LICENSE_SERVER_PROXY_URL = `http://127.0.0.1:${server.address().port}`;
    const result = await auth.getActivationRequestStatus("fallback-request", "fallback-token");
    assert.deepEqual(result, { status: "pending" });
  } finally {
    if (previousServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_URL;
    else process.env.AGENT_LICENSE_SERVER_URL = previousServerUrl;
    if (previousLocalServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
    else process.env.AGENT_LICENSE_SERVER_LOCAL_URL = previousLocalServerUrl;
    if (previousProxyUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_PROXY_URL;
    else process.env.AGENT_LICENSE_SERVER_PROXY_URL = previousProxyUrl;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("dashboard reports a useful error when the public licensing server cannot be reached", async () => {
  const auth = await import("../agent/auth.js");
  const previousServerUrl = process.env.AGENT_LICENSE_SERVER_URL;
  const previousLocalServerUrl = process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
  try {
    process.env.AGENT_LICENSE_SERVER_URL = "http://127.0.0.1:1";
    delete process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
    await assert.rejects(
      () => auth.requestActivationCode("http://localhost:3000", "Local agent dashboard", 600000),
      /licensing server could not be reached.*127\.0\.0\.1:1/i,
    );
  } finally {
    if (previousServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_URL;
    else process.env.AGENT_LICENSE_SERVER_URL = previousServerUrl;
    if (previousLocalServerUrl === undefined) delete process.env.AGENT_LICENSE_SERVER_LOCAL_URL;
    else process.env.AGENT_LICENSE_SERVER_LOCAL_URL = previousLocalServerUrl;
  }
});

test("agent persists Admin authorization across restarts and rejects bad credentials", async () => {
  assert.throws(() => agent.loginAdmin("Admin", "wrong"), /incorrect/i);
  assert.throws(() => agent.loginAdmin("Admin", "12345"), /incorrect/i);
  agent.loginAdmin("Admin", "Aman");
  assert.equal(agent.getAgentState().authorization.mode, "admin");

  const adminSessionResponse = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Admin browser" }),
  });
  assert.equal(adminSessionResponse.status, 200);
  const adminSession = await adminSessionResponse.json();
  agent.logoutAdmin();
  const revokedAdminAccess = await fetch(url("/v1/capabilities"), { headers: { Authorization: `Bearer ${adminSession.token}`, Origin: "http://localhost:3000" } });
  assert.equal(revokedAdminAccess.status, 401);
  agent.loginAdmin("Admin", "Aman");

  await agent.stopAgentServer();
  server = await agent.startAgentServer({ port: 0 });
  port = server.address().port;
  assert.equal(agent.getAgentState().authorization.mode, "admin");
  agent.logoutAdmin();
  // Logging out removes the Admin override and returns to the still-running
  // installation trial; it must not reset or silently extend that trial.
  assert.equal(agent.getAgentState().authorization.mode, "trial");
});

test("agent accepts only a signed, device-bound, one-use activation code", () => {
  assert.throws(() => agent.activateLicense(makeActivationCode({ deviceId: "different-device" })), /different device/i);
  assert.throws(() => agent.activateLicense(makeActivationCode({ deviceId: null })), /not bound to a device/i);
  const code = makeActivationCode();
  const compactCode = code.slice(4).replace(/-/g, "");
  const payload = JSON.parse(Buffer.from(compactCode.slice(0, compactCode.indexOf(".")), "base64url").toString("utf8"));
  assert.equal(payload.deviceId, agent.getDeviceId());
  const signatureStart = compactCode.indexOf(".") + 1;
  const signatureChar = compactCode[signatureStart];
  const tamperedCompact = `${compactCode.slice(0, signatureStart)}${signatureChar === "A" ? "B" : "A"}${compactCode.slice(signatureStart + 1)}`;
  const tampered = `MT1-${tamperedCompact.match(/.{1,4}/g).join("-")}`;
  assert.throws(() => agent.activateLicense(tampered), /signature is invalid/i);

  // The used-license table is local to an installation, so this regression
  // uses a fresh process and data directory to prove device binding prevents
  // the same signed token being accepted somewhere else.
  const otherRoot = path.join(testRoot, "other-installation");
  const childScript = `import { acceptLegalConsent, activate } from "./agent/auth.js";
acceptLegalConsent();
try { activate(process.env.ACTIVATION_CODE); process.exit(0); }
catch (error) { console.error(error.message); process.exit(1); }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    env: {
      ...process.env,
      DATA_DIR: path.join(otherRoot, "data"),
      MEDIA_TOOLBOX_DOWNLOADS_DIR: path.join(otherRoot, "Downloads"),
      AGENT_LICENSE_PUBLIC_KEY: licenseKeys.publicKey,
      ACTIVATION_CODE: code,
    },
    encoding: "utf8",
  });
  assert.notEqual(child.status, 0, `A device-bound activation code was accepted by a second installation: ${child.stdout}${child.stderr}`);
  assert.match(`${child.stdout}\n${child.stderr}`, /different device/i);

  agent.activateLicense(code);
  assert.equal(agent.getAgentState().authorization.mode, "activation");
  assert.throws(() => agent.activateLicense(code), /already been used/i);
});

test("offline tester activation is reusable for ten minutes without a licensing server", () => {
  const childRoot = path.join(testRoot, "offline-tester-installation");
  const childScript = `import { acceptLegalConsent, getAuthorizationState } from "./agent/auth.js";
import { activateLicense } from "./agent/server.js";
acceptLegalConsent();
const first = activateLicense("iamatester");
const second = activateLicense("iamatester");
if (first.mode !== "activation" || second.mode !== "activation") throw new Error("Tester activation did not authorize processing.");
if (first.activationExpiresAt - first.activationStartedAt !== 10 * 60 * 1000) throw new Error("Tester activation did not last ten minutes.");
if (first.activationId === second.activationId) throw new Error("Tester activation was not reusable.");
if (getAuthorizationState().activationExpiresAt - getAuthorizationState().activationStartedAt !== 10 * 60 * 1000) throw new Error("Tester activation duration changed.");`;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    env: {
      ...process.env,
      DATA_DIR: path.join(childRoot, "data"),
      MEDIA_TOOLBOX_DOWNLOADS_DIR: path.join(childRoot, "Downloads"),
      AGENT_LICENSE_SERVER_URL: "http://127.0.0.1:1",
      AGENT_LICENSE_SERVER_LOCAL_URL: "",
    },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, `Reusable offline tester activation failed: ${child.stdout}\n${child.stderr}`);
});

test("agent reports health, rejects unauthenticated jobs, and pairs with a one-time code", async () => {
  const healthResponse = await fetch(url("/v1/health"), { headers: { Origin: "http://localhost:3000" } });
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).ok, true);

  const unauthorized = await fetch(url("/v1/capabilities"), { headers: { Origin: "http://localhost:3000" } });
  assert.equal(unauthorized.status, 401);

  const badPair = await fetch(url("/v1/pair"), { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ code: "000000", origin: "http://localhost:3000" }) });
  assert.equal(badPair.status, 401);

  const goodPair = await fetch(url("/v1/pair"), { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ code: agent.getAgentState().pairingCode, origin: "http://localhost:3000" }) });
  assert.equal(goodPair.status, 200);
  const paired = await goodPair.json();
  assert.ok(paired.token);
  sessionToken = paired.token;

  const capabilities = await fetch(url("/v1/capabilities"), { headers: { Authorization: `Bearer ${paired.token}`, Origin: "http://localhost:3000" } });
  assert.equal(capabilities.status, 200);

  // Native/non-browser callers may omit Origin. A valid paired token must
  // still authorize the request; this also covers the browser pairing race.
  const capabilitiesWithoutOrigin = await fetch(url("/v1/capabilities"), { headers: { Authorization: `Bearer ${paired.token}` } });
  assert.equal(capabilitiesWithoutOrigin.status, 200);

  // The OCR route must be present in the packaged/source agent. An older
  // installed runtime returns the catch-all 404 "Agent route not found", so
  // this protects the route contract used by the PDF text editor.
  const emptyOcrForm = new FormData();
  const ocrRoute = await fetch(url("/v1/pdf/ocr"), {
    method: "POST",
    headers: { Authorization: `Bearer ${paired.token}`, Origin: "http://localhost:3000" },
    body: emptyOcrForm,
  });
  assert.equal(ocrRoute.status, 400);
  assert.match((await ocrRoute.json()).error, /exactly one PDF/i);
});

test("agent rejects a different origin after pairing", async () => {
  const response = await fetch(url("/v1/capabilities"), { headers: { Authorization: "Bearer invalid", Origin: "http://evil.example" } });
  assert.equal(response.status, 401);
});

test("agent deletes a named downloaded server result only inside Downloads", async () => {
  const downloadsDirectory = path.join(testRoot, "Downloads");
  const resultName = "server-result.pdf";
  await fs.mkdir(downloadsDirectory, { recursive: true });
  await fs.writeFile(path.join(downloadsDirectory, resultName), "downloaded result");

  const unauthorized = await fetch(url("/v1/files/delete"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ folderPath: downloadsDirectory, filename: resultName }),
  });
  assert.equal(unauthorized.status, 401);

  const deleted = await fetch(url("/v1/files/delete"), {
    method: "POST",
    headers: { "Authorization": `Bearer ${sessionToken}`, "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ folderPath: downloadsDirectory, filename: resultName }),
  });
  assert.equal(deleted.status, 200);
  assert.equal((await fs.stat(path.join(downloadsDirectory, resultName)).catch(() => null)), null);

  const outsideDirectory = path.join(testRoot, "outside");
  await fs.mkdir(outsideDirectory, { recursive: true });
  await fs.writeFile(path.join(outsideDirectory, resultName), "must stay");
  const rejected = await fetch(url("/v1/files/delete"), {
    method: "POST",
    headers: { "Authorization": `Bearer ${sessionToken}`, "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ folderPath: outsideDirectory, filename: resultName }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await fs.stat(path.join(outsideDirectory, resultName))).isFile(), true);
});

test("agent accepts an authenticated image job and returns a local result", async (t) => {
  const imageTool = await firstAvailable(["magick", "convert"]);
  if (!imageTool) {
    t.skip("ImageMagick is required for the local-agent image fixture.");
    return;
  }
  const sourcePath = path.join(testRoot, "agent-source.png");
  const command = imageTool === "magick" ? "magick" : "convert";
  const created = await runCommand(command, ["-size", "80x50", "xc:skyblue", sourcePath]);
  assert.equal(created.code, 0, created.stderr);
  const form = new FormData();
  form.append("tool", "image-converter");
  form.append("format", "png");
  form.append("method", "imagemagick");
  form.append("jpegConfirmed", "false");
  form.append("retention", "keep");
  form.append("source", new Blob([await fs.readFile(sourcePath)], { type: "image/png" }), "agent-source.png");
  const response = await fetch(url("/v1/jobs"), {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" },
    body: form,
  });
  assert.equal(response.status, 202);
  const createdJob = await response.json();
  assert.ok(createdJob.jobId);

  let completed;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const statusResponse = await fetch(url(`/v1/jobs/${createdJob.jobId}`), { headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" } });
    completed = await statusResponse.json();
    if (["completed", "failed"].includes(completed.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(completed.status, "completed", completed.error || completed.message);
  assert.match(completed.result.filename, /agent-source_converted\.png$/);
  const download = await fetch(completed.result.downloadUrl, { headers: { Origin: "http://localhost:3000" } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "image/png");
  assert.equal((await download.arrayBuffer()).byteLength > 0, true);

  const historyResponse = await fetch(url("/v1/history?tool=image-converter"), { headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" } });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  const retained = history.items.find((item) => item.id === createdJob.jobId);
  assert.ok(retained);
  assert.equal(retained.storedLocally, true);
  assert.match(retained.location, /Results folder/);

  const deleted = await fetch(url(`/v1/history/${createdJob.jobId}`), { method: "DELETE", headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" } });
  assert.equal(deleted.status, 200);
  const missing = await fetch(url(`/v1/jobs/${createdJob.jobId}`), { headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" } });
  assert.equal(missing.status, 404);
});

test("agent supports automatic browser sessions and ending one or all sessions", async () => {
  const automatic = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Safari on macOS" }),
  });
  assert.equal(automatic.status, 200);
  const automaticSession = await automatic.json();
  assert.ok(automaticSession.token);
  assert.ok(automaticSession.sessionId);
  assert.equal(automaticSession.autoPaired, true);

  const secondBrowser = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:3000" },
    body: JSON.stringify({ origin: "http://127.0.0.1:3000", clientLabel: "Chrome private window" }),
  });
  assert.equal(secondBrowser.status, 200);
  const secondBrowserSession = await secondBrowser.json();
  assert.equal(secondBrowserSession.autoPaired, true);

  const differentOrigin = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://another.example" },
    body: JSON.stringify({ origin: "https://another.example", clientLabel: "Chrome" }),
  });
  assert.equal(differentOrigin.status, 403);

  const sessionsResponse = await fetch(url("/v1/sessions"), {
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" },
  });
  assert.equal(sessionsResponse.status, 200);
  const sessions = await sessionsResponse.json();
  assert.ok(sessions.items.some((item) => item.id === automaticSession.sessionId && item.clientLabel === "Safari on macOS"));
  assert.ok(sessions.items.some((item) => item.id === secondBrowserSession.sessionId && item.clientLabel === "Chrome private window"));
  assert.ok(sessions.items.some((item) => item.current));

  const ended = await fetch(url(`/v1/sessions/${automaticSession.sessionId}`), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" },
  });
  assert.equal(ended.status, 200);
  assert.equal((await ended.json()).current, false);
  const endedAccess = await fetch(url("/v1/capabilities"), {
    headers: { Authorization: `Bearer ${automaticSession.token}`, Origin: "http://localhost:3000" },
  });
  assert.equal(endedAccess.status, 401);

  const endedAll = await fetch(url("/v1/sessions/revoke-all"), {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, Origin: "http://localhost:3000" },
  });
  assert.equal(endedAll.status, 200);
  assert.ok((await endedAll.json()).revokedCount >= 1);
  const healthAfterRevoke = await fetch(url("/v1/health"), { headers: { Origin: "http://localhost:3000" } });
  assert.equal((await healthAfterRevoke.json()).paired, false);
});

test("activation authorization expires after exactly ten minutes", async () => {
  const auth = await import("../agent/auth.js");
  const active = auth.activate(makeActivationCode({ durationMs: 10 * 60 * 1000 }));
  assert.equal(active.mode, "activation");
  assert.equal(active.activationExpiresAt - active.activationStartedAt, 10 * 60 * 1000);
  assert.ok(active.remainingMs > 0 && active.remainingMs <= 10 * 60 * 1000);

  const expired = auth.getAuthorizationState(active.activationStartedAt + 10 * 60 * 1000 + 1);
  assert.equal(expired.mode, "locked");
  assert.equal(expired.authorized, false);
  const denied = auth.authorizeProcessing("http://localhost:3000", active.activationStartedAt + 10 * 60 * 1000 + 1);
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "activation_required");
});

test("activation logout and re-login preserve the original expiry deadline", async () => {
  const auth = await import("../agent/auth.js");
  const code = makeActivationCode({ durationMs: 30 * 60 * 1000 });
  const activated = auth.activate(code);
  const startedAt = activated.activationStartedAt;
  const loggedOut = auth.logoutActivation(startedAt + 10 * 60 * 1000);
  assert.equal(loggedOut.mode, "locked");
  assert.equal(loggedOut.reason, "activation_logged_out");
  assert.equal(loggedOut.activationReloginAvailable, true);
  assert.equal(loggedOut.activationExpiresAt, startedAt + 30 * 60 * 1000);
  assert.equal(loggedOut.remainingMs, 20 * 60 * 1000);

  const loggedInAgain = auth.loginActivation(startedAt + 15 * 60 * 1000);
  assert.equal(loggedInAgain.mode, "activation");
  assert.equal(loggedInAgain.activationSessionActive, true);
  assert.equal(loggedInAgain.activationStartedAt, startedAt);
  assert.equal(loggedInAgain.activationExpiresAt, startedAt + 30 * 60 * 1000);
  assert.equal(loggedInAgain.remainingMs, 15 * 60 * 1000);
  assert.throws(() => auth.activate(code), /already been used/i);

  const browserSessionResponse = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Activation logout test" }),
  });
  assert.equal(browserSessionResponse.status, 200);
  const browserSession = await browserSessionResponse.json();
  agent.logoutActivation();
  assert.equal(agent.getAgentState().authorization.mode, "locked");
  assert.equal(agent.getAgentState().authorization.activationReloginAvailable, true);
  const revokedResponse = await fetch(url("/v1/capabilities"), { headers: { Authorization: `Bearer ${browserSession.token}`, Origin: "http://localhost:3000" } });
  assert.equal(revokedResponse.status, 402);
  assert.equal((await revokedResponse.json()).code, "activation_required");
  agent.loginActivation();
  assert.equal(agent.getAgentState().authorization.mode, "activation");
});

test("activation session limits recalculate real time after the second session", async () => {
  const auth = await import("../agent/auth.js");
  const active = auth.getAuthorizationState();
  assert.equal(active.mode, "activation");
  const now = active.activationStartedAt + 10 * 60 * 1000;
  const original = auth.getAuthorizationState(now, 2);
  const secondSession = auth.getAuthorizationState(now, 2);
  assert.equal(secondSession.activationSessionPenaltyCount, 0);
  assert.equal(secondSession.activationEffectiveRemainingMs, original.activationOriginalRemainingMs);

  const thirdAuthorization = auth.getAuthorizationState(now, 3);
  const expectedAfterThird = Math.floor(original.activationOriginalRemainingMs * 2 / 3);
  assert.equal(thirdAuthorization.activationSessionPenaltyCount, 1);
  assert.equal(thirdAuthorization.activationEffectiveRemainingMs, expectedAfterThird);

  const fourthSession = auth.getAuthorizationState(now, 4);
  const expectedAfterFourth = Math.floor(original.activationOriginalRemainingMs * (2 / 3) ** 2);
  assert.equal(fourthSession.activationSessionPenaltyCount, 2);
  assert.equal(fourthSession.activationEffectiveRemainingMs, expectedAfterFourth);
  assert.ok(fourthSession.activationEffectiveRemainingMs < thirdAuthorization.activationEffectiveRemainingMs);

  const session1Response = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Session one" }),
  });
  const session2Response = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Session two" }),
  });
  assert.equal(session1Response.status, 200);
  assert.equal(session2Response.status, 200);
  const session1 = await session1Response.json();
  const session2 = await session2Response.json();
  const thirdResponse = await fetch(url("/v1/session"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
    body: JSON.stringify({ origin: "http://localhost:3000", clientLabel: "Session three" }),
  });
  assert.equal(thirdResponse.status, 200);
  const beforeRemoval = agent.getAgentState().authorization;
  assert.equal(beforeRemoval.activationSessionPenaltyCount, 1);
  const thirdBrowserSession = await thirdResponse.json();
  const removed = await fetch(url(`/v1/sessions/${thirdBrowserSession.sessionId}`), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${session1.token}`, Origin: "http://localhost:3000" },
  });
  assert.equal(removed.status, 200);
  const afterRemoval = agent.getAgentState().authorization;
  assert.equal(afterRemoval.activationSessionPenaltyCount, 0);
  assert.ok(afterRemoval.activationEffectiveRemainingMs > beforeRemoval.activationEffectiveRemainingMs);
  await fetch(url(`/v1/sessions/${session1.sessionId}`), { method: "DELETE", headers: { Authorization: `Bearer ${session2.token}`, Origin: "http://localhost:3000" } });
  agent.revokeAllSessions();
});
