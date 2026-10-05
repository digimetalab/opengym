/* storage.js — Unified database & storage layer for openGym
 * Supports Turso (libSQL) when TURSO_DATABASE_URL / TURSO_URL is set,
 * and falls back to local JSON files in DATA_DIR for self-hosted Docker / local testing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import webpush from 'web-push';

export let isTurso = false;
export let tursoClient = null;

export let SECRET = '';
export let vapid = { publicKey: '', privateKey: '' };
export const db = { users: [], creds: [], subs: [], invites: [], deviceLinks: [] };

// In-memory cache for ultra-fast, sync-compatible reads
const stateCache = new Map(); // uid -> { state, rev, updatedAt }
const challenges = new Map(); // cid -> { ...data, exp }
const pairings = new Map();   // code -> { uid, exp }

let DATA = '/data';
let dbFile = '';
let auditFile = '';
let lastDbFetch = 0;
const DB_CACHE_TTL_MS = 3000;

function atomicWrite(file, content, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

const stateFile = uid => path.join(DATA, 'state-' + uid.replace(/[^a-zA-Z0-9_-]/g, '') + '.json');

export async function initStorage(opts = {}) {
  try {
    if (typeof process.loadEnvFile === 'function') {
      const candidates = [
        path.join(process.cwd(), '.env'),
        path.join(process.cwd(), '..', '.env'),
        path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1')), '.env'),
        path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1')), '..', '.env')
      ];
      for (const envPath of candidates) {
        if (fs.existsSync(envPath)) {
          process.loadEnvFile(envPath);
          break;
        }
      }
    }
  } catch {}

  DATA = opts.dataDir || process.env.DATA_DIR || '/data';
  const url = opts.tursoUrl || process.env.TURSO_DATABASE_URL || process.env.TURSO_URL || process.env.DATABASE_URL || '';
  const authToken = opts.tursoAuthToken || process.env.TURSO_AUTH_TOKEN || '';

  // Clear in-memory caches on init
  stateCache.clear();
  challenges.clear();
  pairings.clear();
  db.users = [];
  db.creds = [];
  db.subs = [];
  db.invites = [];
  db.deviceLinks = [];

  // Check if Turso is configured
  if (url && (url.startsWith('libsql:') || url.startsWith('https:') || url.startsWith('http:') || url.startsWith('file:') || url === ':memory:')) {
    isTurso = true;
    tursoClient = createClient({ url, authToken });

    // Initialize Turso tables
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS app_auth (
        id TEXT PRIMARY KEY,
        data TEXT
      )
    `);
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS user_states (
        uid TEXT PRIMARY KEY,
        state TEXT,
        rev INTEGER DEFAULT 0,
        updated_at INTEGER
      )
    `);
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS app_ephemeral (
        id TEXT PRIMARY KEY,
        type TEXT,
        data TEXT,
        exp INTEGER
      )
    `);
    await tursoClient.execute(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry TEXT,
        created_at INTEGER
      )
    `);

    // Load or generate SECRET
    const secretRow = await tursoClient.execute({
      sql: "SELECT value FROM app_meta WHERE key = 'secret'",
      args: []
    });
    if (secretRow.rows.length) {
      SECRET = String(secretRow.rows[0].value).trim();
    } else {
      SECRET = crypto.randomBytes(32).toString('hex');
      await tursoClient.execute({
        sql: "INSERT INTO app_meta (key, value) VALUES ('secret', ?)",
        args: [SECRET]
      });
    }

    // Load or generate VAPID keys
    const vapidRow = await tursoClient.execute({
      sql: "SELECT value FROM app_meta WHERE key = 'vapid'",
      args: []
    });
    if (vapidRow.rows.length) {
      try {
        vapid = JSON.parse(String(vapidRow.rows[0].value));
      } catch {
        vapid = webpush.generateVAPIDKeys();
      }
    } else {
      vapid = webpush.generateVAPIDKeys();
      await tursoClient.execute({
        sql: "INSERT INTO app_meta (key, value) VALUES ('vapid', ?)",
        args: [JSON.stringify(vapid)]
      });
    }

    // Load db
    await fetchDbFromTurso();

    // Preload user states into cache
    const statesRes = await tursoClient.execute("SELECT uid, state, rev, updated_at FROM user_states");
    for (const row of statesRes.rows) {
      try {
        const s = JSON.parse(String(row.state));
        stateCache.set(String(row.uid), {
          state: s,
          rev: Number(row.rev) || 0,
          updatedAt: Number(row.updated_at) || 0
        });
      } catch {}
    }
  } else {
    // Local filesystem storage fallback
    isTurso = false;
    tursoClient = null;

    try { fs.mkdirSync(DATA, { recursive: true }); } catch {}

    const secretFile = path.join(DATA, 'secret');
    if (!fs.existsSync(secretFile)) {
      fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    SECRET = fs.readFileSync(secretFile, 'utf8').trim();

    dbFile = path.join(DATA, 'db.json');
    let loadedDb = null;
    try { loadedDb = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch {}
    if (loadedDb && typeof loadedDb === 'object') {
      Object.assign(db, loadedDb);
    }
    db.users = db.users || [];
    db.creds = db.creds || [];
    db.subs = db.subs || [];
    db.invites = db.invites || [];
    db.deviceLinks = db.deviceLinks || [];

    const vapidFile = path.join(DATA, 'vapid.json');
    try {
      vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8'));
    } catch {
      vapid = webpush.generateVAPIDKeys();
      try { fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 }); } catch {}
    }

    auditFile = path.join(DATA, 'audit.log');
  }

  const origin = opts.origin || process.env.ORIGIN || 'http://localhost:8080';
  const secure = opts.secure != null ? opts.secure : /^https:/i.test(origin);
  const vapidSubject = process.env.VAPID_SUBJECT || (secure ? origin : 'mailto:admin@localhost');
  try {
    webpush.setVapidDetails(vapidSubject, vapid.publicKey, vapid.privateKey);
  } catch (e) {
    console.warn('VAPID setup warning:', e.message);
  }

  return { SECRET, vapid, db };
}

async function fetchDbFromTurso() {
  const row = await tursoClient.execute({
    sql: "SELECT data FROM app_auth WHERE id = 'db'",
    args: []
  });
  if (row.rows.length) {
    try {
      const loaded = JSON.parse(String(row.rows[0].data));
      db.users = loaded.users || [];
      db.creds = loaded.creds || [];
      db.subs = loaded.subs || [];
      db.invites = loaded.invites || [];
      db.deviceLinks = loaded.deviceLinks || [];
    } catch {}
  } else {
    db.users = [];
    db.creds = [];
    db.subs = [];
    db.invites = [];
    db.deviceLinks = [];
    await tursoClient.execute({
      sql: "INSERT INTO app_auth (id, data) VALUES ('db', ?)",
      args: [JSON.stringify(db)]
    });
  }
  lastDbFetch = Date.now();
}

export async function ensureDbFresh(force = false) {
  if (!isTurso) return db;
  const now = Date.now();
  if (force || now - lastDbFetch > DB_CACHE_TTL_MS) {
    try {
      await fetchDbFromTurso();
    } catch (e) {
      console.error('ensureDbFresh error:', e.message);
    }
  }
  return db;
}

export async function saveDb(targetDb = db) {
  if (isTurso) {
    lastDbFetch = Date.now();
    await tursoClient.execute({
      sql: `INSERT INTO app_auth (id, data) VALUES ('db', ?)
            ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      args: [JSON.stringify(targetDb)]
    });
  } else {
    atomicWrite(dbFile, JSON.stringify(targetDb, null, 2), 0o600);
  }
}

// Synchronous and asynchronous readState
export function readState(uid) {
  if (isTurso) {
    const cached = stateCache.get(uid);
    if (cached) return cached.state;
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(stateFile(uid), 'utf8'));
  } catch {
    return null;
  }
}

export async function readStateAsync(uid) {
  if (isTurso) {
    const cached = stateCache.get(uid);
    if (cached) return cached.state;
    const row = await tursoClient.execute({
      sql: "SELECT state, rev, updated_at FROM user_states WHERE uid = ?",
      args: [uid]
    });
    if (!row.rows.length) return null;
    try {
      const s = JSON.parse(String(row.rows[0].state));
      stateCache.set(uid, {
        state: s,
        rev: Number(row.rows[0].rev) || 0,
        updatedAt: Number(row.rows[0].updated_at) || 0
      });
      return s;
    } catch {
      return null;
    }
  }
  return readState(uid);
}

export function readStateRev(uid) {
  if (isTurso) {
    return stateCache.get(uid)?.rev || 0;
  }
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(uid), 'utf8'));
    return Number(s?._rev) || 0;
  } catch {
    return 0;
  }
}

export async function readStateRevAsync(uid) {
  if (isTurso) {
    const cached = stateCache.get(uid);
    if (cached) return cached.rev;
    const row = await tursoClient.execute({
      sql: "SELECT rev FROM user_states WHERE uid = ?",
      args: [uid]
    });
    if (!row.rows.length) return 0;
    return Number(row.rows[0].rev) || 0;
  }
  return readStateRev(uid);
}

export async function saveState(uid, state) {
  const rev = Number(state?._rev) || 0;
  const now = Date.now();
  stateCache.set(uid, { state, rev, updatedAt: now });

  if (isTurso) {
    await tursoClient.execute({
      sql: `INSERT INTO user_states (uid, state, rev, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(uid) DO UPDATE SET state = excluded.state, rev = excluded.rev, updated_at = excluded.updated_at`,
      args: [uid, JSON.stringify(state), rev, now]
    });
  } else {
    atomicWrite(stateFile(uid), JSON.stringify(state));
  }
}

export async function deleteState(uid) {
  stateCache.delete(uid);
  if (isTurso) {
    await tursoClient.execute({
      sql: "DELETE FROM user_states WHERE uid = ?",
      args: [uid]
    });
  } else {
    try { fs.unlinkSync(stateFile(uid)); } catch {}
  }
}

export async function listUserStates() {
  if (isTurso) {
    const res = await tursoClient.execute("SELECT uid, state, rev, updated_at FROM user_states");
    return res.rows.map(r => ({
      uid: String(r.uid),
      state: (() => { try { return JSON.parse(String(r.state)); } catch { return null; } })(),
      rev: Number(r.rev) || 0,
      updatedAt: Number(r.updated_at) || 0
    }));
  } else {
    try {
      const files = fs.readdirSync(DATA).filter(f => /^state-[a-zA-Z0-9_-]+\.json$/.test(f));
      return files.map(f => {
        const uid = f.slice(6, -5);
        try {
          const state = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
          return { uid, state, rev: state?._rev || 0, updatedAt: state?._ts || 0 };
        } catch {
          return { uid, state: null, rev: 0, updatedAt: 0 };
        }
      });
    } catch {
      return [];
    }
  }
}

/* Ephemeral store (challenges & pairings) */
export async function putChallenge(data, ttlMs = 5 * 60000) {
  const cid = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + ttlMs;
  challenges.set(cid, { ...data, exp });

  if (isTurso) {
    try {
      await tursoClient.execute({
        sql: "INSERT INTO app_ephemeral (id, type, data, exp) VALUES (?, 'challenge', ?, ?)",
        args: [cid, JSON.stringify(data), exp]
      });
    } catch (e) {
      console.error('putChallenge error:', e.message);
    }
  }
  return cid;
}

export async function takeChallenge(cid) {
  if (!cid) return null;
  const local = challenges.get(cid);
  challenges.delete(cid);

  if (isTurso) {
    try {
      const res = await tursoClient.execute({
        sql: "SELECT data, exp FROM app_ephemeral WHERE id = ? AND type = 'challenge'",
        args: [cid]
      });
      if (res.rows.length) {
        await tursoClient.execute({
          sql: "DELETE FROM app_ephemeral WHERE id = ? AND type = 'challenge'",
          args: [cid]
        });
        const { data, exp } = res.rows[0];
        if (Number(exp) >= Date.now()) {
          try { return JSON.parse(String(data)); } catch {}
        }
      }
    } catch (e) {
      console.error('takeChallenge error:', e.message);
    }
  }

  if (local && local.exp >= Date.now()) return local;
  return null;
}

export async function putPairing(code, data, ttlMs = 5 * 60000) {
  const exp = Date.now() + ttlMs;
  pairings.set(code, { ...data, exp });

  if (isTurso) {
    try {
      await tursoClient.execute({
        sql: "INSERT INTO app_ephemeral (id, type, data, exp) VALUES (?, 'pairing', ?, ?)",
        args: [code, JSON.stringify(data), exp]
      });
    } catch (e) {
      console.error('putPairing error:', e.message);
    }
  }
}

export async function hasPairing(code) {
  if (!code) return false;
  const local = pairings.get(code);
  if (local && local.exp >= Date.now()) return true;

  if (isTurso) {
    try {
      const res = await tursoClient.execute({
        sql: "SELECT exp FROM app_ephemeral WHERE id = ? AND type = 'pairing'",
        args: [code]
      });
      if (res.rows.length) return Number(res.rows[0].exp) >= Date.now();
    } catch {}
  }
  return false;
}

export async function takePairing(code) {
  if (!code) return null;
  const local = pairings.get(code);
  pairings.delete(code);

  if (isTurso) {
    try {
      const res = await tursoClient.execute({
        sql: "SELECT data, exp FROM app_ephemeral WHERE id = ? AND type = 'pairing'",
        args: [code]
      });
      if (res.rows.length) {
        await tursoClient.execute({
          sql: "DELETE FROM app_ephemeral WHERE id = ? AND type = 'pairing'",
          args: [code]
        });
        const { data, exp } = res.rows[0];
        if (Number(exp) >= Date.now()) {
          try { return JSON.parse(String(data)); } catch {}
        }
      }
    } catch (e) {
      console.error('takePairing error:', e.message);
    }
  }

  if (local && local.exp >= Date.now()) return local;
  return null;
}

if (!process.env.VERCEL) {
  setInterval(async () => {
    const now = Date.now();
    if (isTurso && tursoClient) {
      try {
        await tursoClient.execute({
          sql: "DELETE FROM app_ephemeral WHERE exp < ?",
          args: [now]
        });
      } catch {}
    }
    for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
    for (const [k, v] of pairings) if (v.exp < now) pairings.delete(k);
  }, 60000).unref?.();
}

/* Audit logs */
export async function appendAudit(rec) {
  if (isTurso) {
    try {
      await tursoClient.execute({
        sql: "INSERT INTO audit_logs (entry, created_at) VALUES (?, ?)",
        args: [JSON.stringify(rec), Date.now()]
      });
    } catch (e) {
      console.error('appendAudit turso error:', e.message);
    }
  } else {
    try {
      fs.appendFileSync(auditFile, JSON.stringify(rec) + '\n');
    } catch (e) {
      console.error('appendAudit file error:', e.message);
    }
  }
}

export async function readAudit(maxCount = 5000, maxDays = 90) {
  if (isTurso) {
    const cutoff = Date.now() - maxDays * 24 * 3600000;
    try {
      const res = await tursoClient.execute({
        sql: "SELECT entry FROM audit_logs WHERE created_at >= ? ORDER BY id DESC LIMIT ?",
        args: [cutoff, maxCount]
      });
      return res.rows.map(r => {
        try { return JSON.parse(String(r.entry)); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  } else {
    try {
      const text = fs.readFileSync(auditFile, 'utf8');
      return text.trim().split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }
}

export async function clearAudit() {
  if (isTurso) {
    try {
      await tursoClient.execute("DELETE FROM audit_logs");
    } catch (e) {
      console.error('clearAudit turso error:', e.message);
    }
  } else {
    try { fs.unlinkSync(auditFile); } catch {}
  }
}
