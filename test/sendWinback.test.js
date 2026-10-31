const test = require('node:test');
const assert = require('node:assert');
const { handleSendWinback, isUsableCopy } = require('../src/handlers/sendWinback');
const { fakeDb } = require('./helpers');

function setup({ status = 'pending', stock = [5], optIn = true, body = null, productMentioned = false } = {}) {
  const stockAnswers = [...stock];
  const db = fakeDb((sql) => {
    if (sql.includes('from campaign_sends cs')) {
      return {
        rows: [{
          id: 1, status, merchant_id: 3, message_body: body, product_mentioned: productMentioned,
          email: 'ann@example.com', first_name: 'Ann', marketing_opt_in: optIn,
          discount_code: 'BACK10', store_name: 'Shop A', from_email: 'shop@a.com',
          product_title: 'Blue Hoodie', inventory_item_id: 9001,
        }],
      };
    }
    if (sql.includes('from inventory_levels')) {
      const available = stockAnswers.length > 1 ? stockAnswers.shift() : stockAnswers[0];
      return { rows: [{ levels: 1, available, untracked: false }] };
    }
  });

  const prompts = [];
  const emails = [];
  const deps = {
    generateCopy: async (input) => {
      prompts.push(input);
      return `Hi Ann, still loving the ${input.productTitle || 'stuff'}? Use BACK10.`;
    },
    sendEmail: async (e) => {
      emails.push(e);
      return { messageId: 'msg-1' };
    },
  };
  return { db, deps, prompts, emails };
}

const job = { payload: { sendId: 1 } };

test('in stock product goes into the prompt and email is sent with idempotency key', async () => {
  const { db, deps, prompts, emails } = setup();
  await handleSendWinback(job, db, deps);
  assert.equal(prompts[0].productTitle, 'Blue Hoodie');
  assert.equal(emails.length, 1);
  assert.equal(emails[0].idempotencyKey, 'winback-send-1');
  assert.ok(db.calls.some((c) => c.sql.includes("status = 'sent'")));
});

test('out of stock product is never given to the llm', async () => {
  const { db, deps, prompts, emails } = setup({ stock: [0] });
  await handleSendWinback(job, db, deps);
  assert.equal(prompts[0].productTitle, null);
  assert.equal(emails.length, 1);
});

test('sold out between generate and send -> template without product', async () => {
  const { db, deps, emails } = setup({ stock: [5, 0] });
  await handleSendWinback(job, db, deps);
  assert.ok(!emails[0].text.includes('Blue Hoodie'));
  assert.ok(emails[0].text.includes('BACK10'));
  assert.ok(db.calls.some((c) => c.sql.includes('sold_out_before_send')));
});

test('llm failure falls back to the template, email still goes out', async () => {
  const { db, deps, emails } = setup();
  deps.generateCopy = async () => { throw new Error('timeout'); };
  await handleSendWinback(job, db, deps);
  assert.equal(emails.length, 1);
  assert.match(emails[0].text, /BACK10/);
});

test('already sent -> no second email', async () => {
  const { db, deps, emails } = setup({ status: 'sent' });
  await handleSendWinback(job, db, deps);
  assert.equal(emails.length, 0);
});

test('retry reuses saved copy instead of calling the llm again', async () => {
  const { db, deps, prompts, emails } = setup({ status: 'sending', body: 'saved copy BACK10' });
  await handleSendWinback(job, db, deps);
  assert.equal(prompts.length, 0);
  assert.equal(emails[0].text, 'saved copy BACK10');
});

test('customer who unsubscribed is skipped', async () => {
  const { db, deps, emails } = setup({ optIn: false });
  await handleSendWinback(job, db, deps);
  assert.equal(emails.length, 0);
  assert.ok(db.calls.some((c) => c.sql.includes("status = 'skipped'")));
});

test('copy without the code is rejected', () => {
  assert.equal(isUsableCopy('hello', 'BACK10'), false);
  assert.equal(isUsableCopy('use BACK10', 'BACK10'), true);
});
