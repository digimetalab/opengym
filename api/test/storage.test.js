import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import * as storage from '../storage.js';

test('storage: in-memory Turso/libSQL mode works end-to-end', async () => {
  const { SECRET, vapid, db } = await storage.initStorage({
    tursoUrl: ':memory:',
    origin: 'http://localhost:8080'
  });

  assert.ok(storage.isTurso, 'isTurso should be true');
  assert.ok(SECRET && SECRET.length >= 32, 'SECRET should be generated');
  assert.ok(vapid.publicKey && vapid.privateKey, 'VAPID keys should be generated');
  assert.deepEqual(db.users, [], 'users should initialize to empty');

  // Test DB save and refresh
  db.users.push({ id: 'u1', name: 'Alice' });
  await storage.saveDb();

  await storage.ensureDbFresh(true);
  assert.equal(storage.db.users.length, 1);
  assert.equal(storage.db.users[0].name, 'Alice');

  // Test state save, read, rev, and delete
  const sampleState = { _rev: 1, workouts: [{ id: 'w1' }], routines: [] };
  await storage.saveState('u1', sampleState);

  const read = await storage.readState('u1');
  assert.deepEqual(read, sampleState);

  const rev = await storage.readStateRev('u1');
  assert.equal(rev, 1);

  const list = await storage.listUserStates();
  assert.equal(list.length, 1);
  assert.equal(list[0].uid, 'u1');

  await storage.deleteState('u1');
  const readAfterDelete = await storage.readState('u1');
  assert.equal(readAfterDelete, null);

  // Test ephemeral challenge
  const cid = await storage.putChallenge({ kind: 'login', challenge: 'xyz123' }, 60000);
  assert.ok(cid);
  const challenge = await storage.takeChallenge(cid);
  assert.equal(challenge?.kind, 'login');
  assert.equal(challenge?.challenge, 'xyz123');

  // After take, challenge should be deleted (single use)
  const challenge2 = await storage.takeChallenge(cid);
  assert.equal(challenge2, null);

  // Test audit logs
  await storage.appendAudit({ event: 'test.event', ok: true });
  const logs = await storage.readAudit(10);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].event, 'test.event');

  await storage.clearAudit();
  const logsAfterClear = await storage.readAudit(10);
  assert.equal(logsAfterClear.length, 0);
});

test('storage: local filesystem fallback works', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-storage-test-'));

  try {
    const { SECRET, vapid, db } = await storage.initStorage({
      dataDir: tmpDir,
      tursoUrl: '' // force fallback
    });

    assert.equal(storage.isTurso, false, 'isTurso should be false');
    assert.ok(SECRET);
    assert.ok(vapid.publicKey);

    db.users.push({ id: 'u2', name: 'Bob' });
    await storage.saveDb();

    assert.ok(fs.existsSync(path.join(tmpDir, 'db.json')));
    const dbFileContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'db.json'), 'utf8'));
    assert.equal(dbFileContent.users[0].name, 'Bob');

    await storage.saveState('u2', { _rev: 5, workouts: [] });
    assert.ok(fs.existsSync(path.join(tmpDir, 'state-u2.json')));

    const state = await storage.readState('u2');
    assert.equal(state._rev, 5);

    const rev = await storage.readStateRev('u2');
    assert.equal(rev, 5);

    await storage.deleteState('u2');
    assert.equal(fs.existsSync(path.join(tmpDir, 'state-u2.json')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
