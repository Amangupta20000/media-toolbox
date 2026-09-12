import fs from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { ensureLicenseStorage } from "./storage.js";

export function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function token() {
  return randomBytes(32).toString("base64url");
}

export const LICENSE_REQUEST_RETENTION_MS = Object.freeze({
  redeemed: 60 * 60 * 1000,
  declined: 30 * 60 * 1000,
  approved: 24 * 60 * 60 * 1000,
});

export class LicenseStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.database = new Database(`${dataDir}/licenses.sqlite3`);
    this.database.pragma("journal_mode = DELETE");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS license_requests (
        id TEXT PRIMARY KEY,
        request_token_hash TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL,
        requester_label TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'redeemed', 'expired')),
        duration_ms INTEGER NOT NULL,
        license_id TEXT UNIQUE,
        code_hash TEXT UNIQUE,
        code_ciphertext TEXT,
        code_iv TEXT,
        code_tag TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        redeemed_at INTEGER,
        redeemed_device_id TEXT,
        redeemed_origin TEXT,
        decline_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS license_requests_status_idx ON license_requests(status, created_at);
      CREATE TABLE IF NOT EXISTS license_consumptions (
        license_id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL,
        origin TEXT NOT NULL,
        redeemed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        request_id TEXT,
        origin TEXT,
        details TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
    `);
  }

  close() {
    this.database.close();
  }

  createRequest({ origin, requesterLabel = "", durationMs, now, expiresAt }) {
    const id = randomUUID();
    const requestToken = token();
    this.database.prepare(`INSERT INTO license_requests
      (id, request_token_hash, origin, requester_label, status, duration_ms, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
      .run(id, sha256(requestToken), origin, requesterLabel, durationMs, now, now, expiresAt);
    this.audit("request.created", id, origin, { requesterLabel });
    return { id, requestToken };
  }

  getRequest(id) {
    return this.database.prepare("SELECT * FROM license_requests WHERE id = ?").get(id) || null;
  }

  getRequestForToken(id, requestToken) {
    return this.database.prepare("SELECT * FROM license_requests WHERE id = ? AND request_token_hash = ?").get(id, sha256(requestToken)) || null;
  }

  listRequests() {
    return this.database.prepare("SELECT * FROM license_requests ORDER BY created_at DESC LIMIT 200").all();
  }

  approve(id, { licenseId, codeHash, encryptedCode, now }) {
    const result = this.database.transaction(() => {
      const row = this.getRequest(id);
      if (!row) throw new Error("License request not found.");
      if (row.status !== "pending") throw new Error("Only pending license requests can be approved.");
      if (row.expires_at <= now) {
        this.database.prepare("UPDATE license_requests SET status = 'expired', updated_at = ? WHERE id = ?").run(now, id);
        throw new Error("This license request has expired.");
      }
      this.database.prepare(`UPDATE license_requests SET status = 'approved', license_id = ?, code_hash = ?, code_ciphertext = ?, code_iv = ?, code_tag = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .run(licenseId, codeHash, encryptedCode.ciphertext, encryptedCode.iv, encryptedCode.tag, now, id);
      this.audit("request.approved", id, row.origin, { licenseId });
      return this.getRequest(id);
    })();
    return result;
  }

  decline(id, { reason = "Declined by owner", now }) {
    const result = this.database.transaction(() => {
      const row = this.getRequest(id);
      if (!row) throw new Error("License request not found.");
      if (row.status !== "pending") throw new Error("Only pending license requests can be declined.");
      this.database.prepare("UPDATE license_requests SET status = 'declined', decline_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(reason, now, id);
      this.audit("request.declined", id, row.origin, { reason });
      return this.getRequest(id);
    })();
    return result;
  }

  consume({ licenseId, codeHash, deviceId, origin, now }) {
    return this.database.transaction(() => {
      const row = this.database.prepare("SELECT * FROM license_requests WHERE license_id = ? AND code_hash = ?").get(licenseId, codeHash);
      if (!row) throw new Error("The activation code is invalid or was not issued by this licensing server.");
      if (row.status !== "approved") throw new Error("This activation code has already been used or is no longer active.");
      if (row.expires_at <= now) {
        this.database.prepare("UPDATE license_requests SET status = 'expired', updated_at = ? WHERE id = ?").run(now, row.id);
        throw new Error("This activation code has expired.");
      }
      const result = this.database.prepare(`UPDATE license_requests SET status = 'redeemed', redeemed_at = ?, redeemed_device_id = ?, redeemed_origin = ?, updated_at = ?, code_ciphertext = NULL, code_iv = NULL, code_tag = NULL WHERE id = ? AND status = 'approved'`).run(now, deviceId, origin, now, row.id);
      if (result.changes !== 1) throw new Error("This activation code has already been used.");
      this.database.prepare("INSERT INTO license_consumptions (license_id, code_hash, device_id, origin, redeemed_at) VALUES (?, ?, ?, ?, ?)").run(licenseId, codeHash, deviceId, origin, now);
      this.audit("license.redeemed", row.id, origin, { licenseId, deviceId });
      return { ...row, status: "redeemed", redeemedAt: now };
    })();
  }

  createAdminSession({ now, expiresAt }) {
    const raw = token();
    this.database.prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(sha256(raw), now, expiresAt);
    return { token: raw, expiresAt };
  }

  getAdminSession(raw, now) {
    const row = this.database.prepare("SELECT * FROM admin_sessions WHERE token_hash = ? AND expires_at > ?").get(sha256(raw), now);
    return row || null;
  }

  deleteAdminSession(raw) {
    this.database.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").run(sha256(raw));
  }

  getSetting(key) {
    return this.database.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value || null;
  }

  setSetting(key, value) {
    this.database.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }

  cleanup(now) {
    return this.database.transaction(() => {
      const expiredAdminSessions = this.database.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").run(now).changes;
      const expiredPendingRequests = this.database.prepare("UPDATE license_requests SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?").run(now, now).changes;
      const deletedRedeemedRequests = this.database.prepare("DELETE FROM license_requests WHERE status = 'redeemed' AND redeemed_at IS NOT NULL AND redeemed_at <= ?").run(now - LICENSE_REQUEST_RETENTION_MS.redeemed).changes;
      const deletedDeclinedRequests = this.database.prepare("DELETE FROM license_requests WHERE status = 'declined' AND updated_at <= ?").run(now - LICENSE_REQUEST_RETENTION_MS.declined).changes;
      const deletedApprovedRequests = this.database.prepare("DELETE FROM license_requests WHERE status = 'approved' AND updated_at <= ?").run(now - LICENSE_REQUEST_RETENTION_MS.approved).changes;
      return { expiredAdminSessions, expiredPendingRequests, deletedRedeemedRequests, deletedDeclinedRequests, deletedApprovedRequests };
    })();
  }

  audit(event, requestId, origin, details = {}) {
    this.database.prepare("INSERT INTO audit_log (event, request_id, origin, details, created_at) VALUES (?, ?, ?, ?, ?)").run(event, requestId || null, origin || null, JSON.stringify(details), Date.now());
  }
}

export async function createLicenseStore(dataDir) {
  const safeDataDir = await ensureLicenseStorage(dataDir);
  return new LicenseStore(safeDataDir);
}
