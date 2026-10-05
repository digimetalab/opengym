import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('server running with Turso libSQL database', async t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-turso-srv-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const tursoUrl = 'file:' + dbPath.replace(/\\/g, '/');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: tmpDir,
      TURSO_DATABASE_URL: tursoUrl,
      ORIGIN: 'http://localhost:8080',
      RP_ID: 'localhost'
    }
  });

  t.after(() => {
    child.kill('SIGKILL');
    try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch {}
  });

  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const port = await boundPort(child, () => log);
  const base = `http://127.0.0.1:${port}`;

  // 1. Check health
  const healthRes = await fetch(`${base}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.ok, true);

  // 2. Check config
  const configRes = await fetch(`${base}/api/config`);
  assert.equal(configRes.status, 200);
  const configJson = await configRes.json();
  assert.equal(configJson.allow_guest, true);

  // 3. Register options
  const regOptRes = await fetch(`${base}/api/register/options`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:8080' },
    body: JSON.stringify({ name: 'TursoUser' })
  });
  assert.equal(regOptRes.status, 200);
  const regOptJson = await regOptRes.json();
  assert.ok(regOptJson.cid, 'should have cid');
  assert.ok(regOptJson.options?.challenge, 'should have challenge');

  // 4. Verify SQLite database file exists on disk
  assert.ok(fs.existsSync(dbPath), 'Turso SQLite database file should be created');
});
