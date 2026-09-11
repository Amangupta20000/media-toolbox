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
    conversion: {
      progress: row.conversion_progress >= 0 ? row.conversion_progress : null,
      current: row.conversion_current || "",
      total: row.conversion_total || "",
    },
    result,
    error: row.error,
  };
}
