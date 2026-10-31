const crypto = require('crypto');
const express = require('express');
const { withTransaction } = require('./db');
const { enqueue } = require('./queue');

const TOPICS = ['orders/create', 'inventory_levels/update'];

function verifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(hmacHeader, 'base64');
  return given.length === digest.length && crypto.timingSafeEqual(given, digest);
}

// The handler does as little as possible: verify, store, enqueue, 200.
// All the real work happens in the worker, so a flash sale only makes the jobs table longer,
// it doesn't hold open requests or hammer the db with heavy queries.
function webhookRouter({ db, secret }) {
  const router = express.Router();

  router.post('/shopify', express.raw({ type: '*/*', limit: '1mb' }), async (req, res, next) => {
    try {
      if (!verifyHmac(req.body, req.get('X-Shopify-Hmac-Sha256'), secret)) {
        return res.status(401).json({ error: 'invalid signature' });
      }

      const topic = req.get('X-Shopify-Topic');
      const webhookId = req.get('X-Shopify-Webhook-Id');
      const shop = req.get('X-Shopify-Shop-Domain');

      // shopify only needs a 2xx, don't make it retry topics we don't care about
      if (!TOPICS.includes(topic)) return res.status(200).json({ ignored: true });
      if (!webhookId || !shop) return res.status(400).json({ error: 'missing headers' });

      const merchant = await db.query('select id from merchants where shop_domain = $1', [shop]);
      if (!merchant.rows.length) return res.status(404).json({ error: 'unknown shop' });
      const merchantId = merchant.rows[0].id;

      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch (e) {
        return res.status(400).json({ error: 'bad json' });
      }

      const duplicate = await withTransaction(db, async (client) => {
        const ins = await client.query(
          `insert into webhook_events (merchant_id, webhook_id, topic, payload)
           values ($1, $2, $3, $4)
           on conflict (webhook_id) do nothing
           returning id`,
          [merchantId, webhookId, topic, payload]
        );
        if (!ins.rows.length) return true;

        await enqueue(client, topic, { eventId: ins.rows[0].id });
        return false;
      });

      res.status(200).json({ ok: true, duplicate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { webhookRouter, verifyHmac };
