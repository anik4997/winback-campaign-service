const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/app');
const { hashKey } = require('../src/auth');
const { fakeDb, listen } = require('./helpers');

function db() {
  return fakeDb((sql, params) => {
    if (sql.includes('from merchants where api_key_hash')) {
      return { rows: params[0] === hashKey('good-key') ? [{ id: 3 }] : [] };
    }
    if (sql.includes('insert into campaigns')) return { rows: [{ id: 50 }] };
    if (sql.includes('insert into campaign_sends')) return { rows: [], rowCount: 12 };
  });
}

async function trigger(d, { key = 'good-key', body = { discountCode: 'BACK10' } } = {}) {
  const { server, url } = await listen(createApp({ db: d }));
  const res = await fetch(`${url}/api/campaigns/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  server.close();
  return res;
}

test('401 without a valid api key', async () => {
  const res = await trigger(db(), { key: 'wrong' });
  assert.equal(res.status, 401);
});

test('400 on a weird discount code', async () => {
  const res = await trigger(db(), { body: { discountCode: "X' OR 1=1 --" } });
  assert.equal(res.status, 400);
});

test('queues sends for the authenticated merchant only, ignores merchantId in body', async () => {
  const d = db();
  const res = await trigger(d, { body: { discountCode: 'BACK10', merchantId: 999 } });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { campaignId: 50, queued: 12 });

  const ins = d.calls.find((c) => c.sql.includes('insert into campaign_sends'));
  assert.equal(ins.params[0], 3);
  // values are passed as params, never put into the sql string
  assert.ok(!ins.sql.includes('BACK10'));
});
