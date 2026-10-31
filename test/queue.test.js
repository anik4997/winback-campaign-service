const test = require('node:test');
const assert = require('node:assert');
const { backoffSeconds, failJob, PermanentError } = require('../src/queue');
const { fakeDb } = require('./helpers');

test('backoff grows and is capped', () => {
  assert.equal(backoffSeconds(1), 10);
  assert.equal(backoffSeconds(3), 90);
  assert.equal(backoffSeconds(50), 900);
});

test('failJob retries until max attempts, permanent errors die at once', async () => {
  const db = fakeDb(() => {});
  assert.equal(await failJob(db, { id: 1, attempts: 1, max_attempts: 5 }, new Error('timeout')), false);
  assert.match(db.calls[0].sql, /status = 'queued'/);

  assert.equal(await failJob(db, { id: 1, attempts: 5, max_attempts: 5 }, new Error('timeout')), true);
  assert.equal(await failJob(db, { id: 2, attempts: 1, max_attempts: 5 }, new PermanentError('nope')), true);
});
