const express = require('express');
const { withTransaction } = require('./db');
const { requireMerchant } = require('./auth');

const INACTIVE_DAYS = 60;
const COOLDOWN_DAYS = 30; // don't win-back the same customer twice within this
const CODE_RE = /^[A-Za-z0-9_-]{3,40}$/;

function campaignRouter({ db }) {
  const router = express.Router();

  // Only creates the campaign + one queued job per customer, then returns 202.
  // The slow part (llm + email) happens in the worker, so this request is fast
  // no matter how many customers the merchant has.
  router.post('/trigger', requireMerchant(db), async (req, res, next) => {
    try {
      const merchantId = req.merchantId;
      const discountCode = String((req.body && req.body.discountCode) || '').trim();
      const idempotencyKey = req.get('Idempotency-Key') || null;

      if (!CODE_RE.test(discountCode)) {
        return res.status(400).json({ error: 'discountCode must be 3-40 letters, numbers, - or _' });
      }
      if (idempotencyKey && idempotencyKey.length > 100) {
        return res.status(400).json({ error: 'Idempotency-Key too long' });
      }

      const result = await withTransaction(db, async (client) => {
        // one trigger at a time per merchant, so two clicks can't queue the same customers twice
        await client.query('select pg_advisory_xact_lock($1)', [merchantId]);

        const ins = await client.query(
          `insert into campaigns (merchant_id, discount_code, idempotency_key)
           values ($1, $2, $3)
           on conflict (merchant_id, idempotency_key) do nothing
           returning id`,
          [merchantId, discountCode, idempotencyKey]
        );

        if (!ins.rows.length) {
          // same Idempotency-Key as before -> return the original campaign, don't queue again
          const existing = await client.query(
            `select c.id, count(cs.id)::int as queued
               from campaigns c left join campaign_sends cs on cs.campaign_id = c.id
              where c.merchant_id = $1 and c.idempotency_key = $2
              group by c.id`,
            [merchantId, idempotencyKey]
          );
          return { campaignId: existing.rows[0].id, queued: existing.rows[0].queued, replay: true };
        }

        const campaignId = ins.rows[0].id;

        const queued = await client.query(
          `with eligible as (
             select c.id
               from customers c
              where c.merchant_id = $1
                and c.orders_count >= 2
                and c.marketing_opt_in
                and c.email is not null
                and c.last_order_at < now() - make_interval(days => $3)
                and not exists (
                  select 1 from campaign_sends cs
                   where cs.merchant_id = $1 and cs.customer_id = c.id
                     and cs.created_at > now() - make_interval(days => $4)
                )
           ),
           sends as (
             insert into campaign_sends (campaign_id, merchant_id, customer_id)
             select $2, $1, id from eligible
             returning id
           )
           insert into jobs (type, payload)
           select 'send_winback', jsonb_build_object('sendId', id) from sends`,
          [merchantId, campaignId, INACTIVE_DAYS, COOLDOWN_DAYS]
        );

        return { campaignId, queued: queued.rowCount, replay: false };
      });

      res.status(result.replay ? 200 : 202).json({
        campaignId: result.campaignId,
        queued: result.queued,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { campaignRouter };
