import assert from 'node:assert/strict';
import test from 'node:test';
import { Miniflare } from 'miniflare';

import worker from '../src/index.js';
import { clearHistory, weeklyCleanup } from '../src/database/schema.js';
import { recordServerStatusTransitions } from '../src/database/statusHistory.js';

async function getTableNames(db) {
  const { results = [] } = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all();
  return new Set(results.map((row) => row.name));
}

test('cron initializes status history once; clearHistory and weekly cleanup recreate required tables', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("OK"); } }',
    d1Databases: { DB: 'status-history-schema-lifecycle-test' }
  });

  try {
    const db = await miniflare.getD1Database('DB');

    await worker.scheduled({ cron: '*/1 * * * *' }, { DB: db }, {});
    let tables = await getTableNames(db);
    assert.ok(tables.has('server_status_history'), 'minute cron initializes the status history table before polling');
    assert.ok(tables.has('metrics_history'));

    const cleared = await clearHistory(db);
    assert.equal(cleared.success, true);
    tables = await getTableNames(db);
    assert.ok(tables.has('server_status_history'), 'clearHistory recreates the status history table');
    assert.ok(tables.has('metrics_history'), 'clearHistory recreates the metrics history table');

    await db.prepare('DROP TABLE server_status_history').run();
    const cleanup = await weeklyCleanup(db);
    assert.equal(cleanup.success, true);
    tables = await getTableNames(db);
    assert.ok(tables.has('server_status_history'), 'weekly cleanup reinitializes a missing status history table');
    assert.ok(tables.has('metrics_history'), 'weekly cleanup creates a fresh metrics history table');
    assert.ok(tables.has('metrics_history_old'), 'weekly cleanup retains the rotated metrics history table');

    const recorded = await recordServerStatusTransitions(db, [{ id: 'after-cleanup' }], new Map(), Date.now());
    assert.equal(recorded, 1, 'the recreated status history table accepts writes without per-operation DDL');
  } finally {
    await miniflare.dispose();
  }
});
