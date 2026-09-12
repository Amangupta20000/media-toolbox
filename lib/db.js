import fs from "node:fs";
import Database from "better-sqlite3";
import { paths } from "./config.js";

let database;

function getDatabase() {
  if (database) return database;
  fs.mkdirSync(paths.jobs, { recursive: true });
  database = new Database(paths.database);
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      status TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_name TEXT NOT NULL,
      reference_path TEXT,
      reference_name TEXT,
      options_json TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL DEFAULT 'Queued',
      message TEXT NOT NULL DEFAULT '',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      logs_json TEXT NOT NULL DEFAULT '[]',
      conversion_progress INTEGER NOT NULL DEFAULT -1,
      conversion_current TEXT NOT NULL DEFAULT '',
      conversion_total TEXT NOT NULL DEFAULT '',
      result_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
    CREATE TABLE IF NOT EXISTS agent_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_id TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT 'Admin',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      admin_unlocked INTEGER NOT NULL DEFAULT 0,
      trial_started_at INTEGER,
      trial_consumed INTEGER NOT NULL DEFAULT 0,
      activation_id TEXT,
      activation_started_at INTEGER,
      activation_expires_at INTEGER,
      activation_origins_json TEXT NOT NULL DEFAULT '[]',
      activation_code_hash TEXT,
      activation_session_active INTEGER NOT NULL DEFAULT 1,
      privacy_accepted_at INTEGER,
      privacy_version TEXT,
      terms_accepted_at INTEGER,
      terms_version TEXT,
      last_seen_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS agent_used_licenses (
      license_id TEXT PRIMARY KEY,
      used_at INTEGER NOT NULL
    );
  `);
  try {
    database.exec("ALTER TABLE jobs ADD COLUMN logs_json TEXT NOT NULL DEFAULT '[]'");
  } catch (error) {
    if (!/duplicate column name/i.test(error.message)) throw error;
  }
  for (const column of [
    "conversion_progress INTEGER NOT NULL DEFAULT -1",
    "conversion_current TEXT NOT NULL DEFAULT ''",
    "conversion_total TEXT NOT NULL DEFAULT ''",
  ]) {
    try {
      database.exec(`ALTER TABLE jobs ADD COLUMN ${column}`);
    } catch (error) {
      if (!/duplicate column name/i.test(error.message)) throw error;
    }
  }
  for (const column of [
    "activation_session_active INTEGER NOT NULL DEFAULT 1",
    "privacy_accepted_at INTEGER",
    "privacy_version TEXT",
    "terms_accepted_at INTEGER",
    "terms_version TEXT",
  ]) {
    try {
      database.exec(`ALTER TABLE agent_auth ADD COLUMN ${column}`);
    } catch (error) {
      if (!/duplicate column name/i.test(error.message)) throw error;
    }
  }
  return database;
}

export function createJob(input) {
  const now = Date.now();
  getDatabase().prepare(`INSERT INTO jobs
    (id, tool, status, source_path, source_name, reference_path, reference_name, options_json, created_at, updated_at)
    VALUES (@id, @tool, 'queued', @sourcePath, @sourceName, @referencePath, @referenceName, @optionsJson, @now, @now)`).run({
    id: input.id,
    tool: input.tool,
    sourcePath: input.sourcePath,
    sourceName: input.sourceName,
    referencePath: input.referencePath || null,
    referenceName: input.referenceName || null,
    optionsJson: JSON.stringify(input.options),
    now,
  });
}

export function getJob(id) {
  return getDatabase().prepare("SELECT * FROM jobs WHERE id = ?").get(id);
}

export function listRetainedJobs(tool) {
  const rows = getDatabase().prepare("SELECT * FROM jobs WHERE tool = ? AND status = 'completed' ORDER BY updated_at DESC").all(tool);
  return rows.filter((row) => {
    try { return JSON.parse(row.options_json || "{}").retention === "keep"; } catch { return false; }
  });
}

export function listCompletedJobs(tool) {
  return getDatabase().prepare("SELECT * FROM jobs WHERE tool = ? AND status = 'completed' ORDER BY updated_at DESC").all(tool);
}

export function claimNextJob() {
  const db = getDatabase();
  const transaction = db.transaction(() => {
    const row = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get();
    if (!row) return undefined;
    db.prepare("UPDATE jobs SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'queued'").run(Date.now(), row.id);
    return row;
  });
  return transaction();
}

export function updateJob(id, update) {
  const fields = ["updated_at = @updatedAt"];
  const params = { id, updatedAt: Date.now() };
  if (update.status) { fields.push("status = @status"); params.status = update.status; }
  if (typeof update.progress === "number") { fields.push("progress = @progress"); params.progress = update.progress; }
  if (update.stage) { fields.push("stage = @stage"); params.stage = update.stage; }
  if (update.message !== undefined) { fields.push("message = @message"); params.message = update.message; }
  if (update.warnings) { fields.push("warnings_json = @warningsJson"); params.warningsJson = JSON.stringify(update.warnings); }
  if (typeof update.conversionProgress === "number") { fields.push("conversion_progress = @conversionProgress"); params.conversionProgress = update.conversionProgress; }
  if (update.conversionCurrent !== undefined) { fields.push("conversion_current = @conversionCurrent"); params.conversionCurrent = update.conversionCurrent; }
  if (update.conversionTotal !== undefined) { fields.push("conversion_total = @conversionTotal"); params.conversionTotal = update.conversionTotal; }
  if (update.result !== undefined) { fields.push("result_json = @resultJson"); params.resultJson = JSON.stringify(update.result); }
  if (update.error !== undefined) { fields.push("error = @error"); params.error = update.error; }
  getDatabase().prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

export function appendJobLog(id, message, level = "info") {
  const db = getDatabase();
  const row = db.prepare("SELECT logs_json FROM jobs WHERE id = ?").get(id);
  if (!row) return;
  let logs = [];
  try { logs = JSON.parse(row.logs_json || "[]"); } catch { logs = []; }
  logs.push({ time: new Date().toISOString(), level, message });
  db.prepare("UPDATE jobs SET logs_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(logs.slice(-250)), Date.now(), id);
}

export function listExpiredJobs(cutoff) {
  return getDatabase().prepare("SELECT id FROM jobs WHERE updated_at < ? AND status IN ('completed', 'failed')").all(cutoff);
}

export function deleteJob(id) {
  getDatabase().prepare("DELETE FROM jobs WHERE id = ?").run(id);
}

export function getJobForPublic(id) {
  const row = getJob(id);
  if (!row) return null;
  const result = row.result_json ? JSON.parse(row.result_json) : null;
  if (result) {
    delete result.path;
    result.downloadUrl = `/api/jobs/${row.id}/download`;
    result.previewUrl = `/api/jobs/${row.id}/download?preview=1`;
  }
  return {
    id: row.id,
    tool: row.tool,
    status: row.status,
    progress: row.progress,
    stage: row.stage,
    message: row.message,
    warnings: JSON.parse(row.warnings_json || "[]"),
    logs: JSON.parse(row.logs_json || "[]"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    conversion: {
      progress: row.conversion_progress >= 0 ? row.conversion_progress : null,
      current: row.conversion_current || "",
      total: row.conversion_total || "",
    },
    result,
    error: row.error,
  };
}

export function getAgentAuth() {
  return getDatabase().prepare("SELECT * FROM agent_auth WHERE id = 1").get() || null;
}

export function createAgentAuth(input) {
  getDatabase().prepare(`INSERT INTO agent_auth
    (id, device_id, username, password_salt, password_hash, admin_unlocked, trial_started_at, trial_consumed, activation_origins_json)
    VALUES (1, @deviceId, @username, @passwordSalt, @passwordHash, 0, NULL, 0, '[]')`).run({
    deviceId: input.deviceId,
    username: input.username || "Admin",
    passwordSalt: input.passwordSalt,
    passwordHash: input.passwordHash,
  });
}

export function updateAgentAuth(update) {
  const fields = [];
  const params = {};
  const columns = {
    deviceId: "device_id",
    username: "username",
    passwordSalt: "password_salt",
    passwordHash: "password_hash",
    adminUnlocked: "admin_unlocked",
    trialStartedAt: "trial_started_at",
    trialConsumed: "trial_consumed",
    activationId: "activation_id",
    activationStartedAt: "activation_started_at",
    activationExpiresAt: "activation_expires_at",
    activationOriginsJson: "activation_origins_json",
    activationCodeHash: "activation_code_hash",
    activationSessionActive: "activation_session_active",
    privacyAcceptedAt: "privacy_accepted_at",
    privacyVersion: "privacy_version",
    termsAcceptedAt: "terms_accepted_at",
    termsVersion: "terms_version",
    lastSeenAt: "last_seen_at",
  };
  for (const [key, column] of Object.entries(columns)) {
    if (Object.prototype.hasOwnProperty.call(update, key)) {
      fields.push(`${column} = @${key}`);
      params[key] = update[key];
    }
  }
  if (!fields.length) return getAgentAuth();
  getDatabase().prepare(`UPDATE agent_auth SET ${fields.join(", ")} WHERE id = 1`).run(params);
  return getAgentAuth();
}

export function hasUsedAgentLicense(licenseId) {
  return Boolean(getDatabase().prepare("SELECT license_id FROM agent_used_licenses WHERE license_id = ?").get(licenseId));
}

export function recordUsedAgentLicense(licenseId, usedAt = Date.now()) {
  getDatabase().prepare("INSERT INTO agent_used_licenses (license_id, used_at) VALUES (?, ?)").run(licenseId, usedAt);
}
