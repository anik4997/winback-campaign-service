const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createApp } = require('../src/app');
const { fakeDb, listen } = require('./helpers');

const SECRET = 'test-secret';

function sign(raw) {
  return crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
}

function post(url, body, headers = {}) {
  const raw = JSON.stringify(body);
  return fetch(`${url}/webhooks/shopify`, {
    method: 'POST',
    body: raw,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': sign(raw),
      'X-Shopify-Topic': 'orders/create',
      'X-Shopify-Webhook-Id': 'wh-1',
      'X-Shopify-Shop-Domain': 'a.myshopify.com',
      ...headers,
    },
  });
}

function db({ duplicate = false } = {}) {
  return fakeDb((sql) => {
    if (sql.includes('from merchants')) return { rows: [{ id: 7 }] };
    if (sql.includes('insert into webhook_events')) return { rows: duplicate ? [] : [{ id: 99 }] };
    if (sql.includes('insert into jobs')) return { rows: [{ id: 1 }] };
  });
}

test('rejects bad signature', async () => {
  const d = db();
  const { server, url } = await listen(createApp({ db: d, webhookSecret: SECRET }));
  const res = await post(url, { id: 1 }, { 'X-Shopify-Hmac-Sha256': 'aGVsbG8=' });
  server.close();
  assert.equal(res.status, 401);
  assert.equal(d.calls.length, 0);
});

test('stores event and queues a job', async () => {
  const d = db();
  const { server, url } = await listen(createApp({ db: d, webhookSecret: SECRET }));
  const res = await post(url, { id: 1 });
  server.close();
  assert.equal(res.status, 200);
  const job = d.calls.find((c) => c.sql.includes('insert into jobs'));
  assert.deepEqual(job.params[1], { eventId: 99 });
  assert.equal(d.calls.find((c) => c.sql.includes('insert into webhook_events')).params[0], 7);
});

test('duplicate webhook id is acked but not queued again', async () => {
  const d = db({ duplicate: true });
  const { server, url } = await listen(createApp({ db: d, webhookSecret: SECRET }));
  const res = await post(url, { id: 1 });
  server.close();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
  assert.ok(!d.calls.some((c) => c.sql.includes('insert into jobs')));
});

test('ignores topics we do not handle', async () => {
  const d = db();
  const { server, url } = await listen(createApp({ db: d, webhookSecret: SECRET }));
  const res = await post(url, {}, { 'X-Shopify-Topic': 'products/update' });
  server.close();
  assert.equal(res.status, 200);
  assert.equal(d.calls.length, 0);
});
