# winback-campaign-service

Small Node.js + PostgreSQL service for automated win-back campaigns on Shopify stores:

- takes `orders/create` and `inventory_levels/update` webhooks from many stores
- sends a personalised (LLM written) discount email to repeat customers who haven't ordered in 60 days
- never mentions a product that is out of stock
- attributes orders that use the campaign code back to the email, so a merchant can see the revenue

It started as a rewrite of a `POST /api/campaigns/trigger` endpoint that looped over every customer
inside the request, calling the LLM and the email API one by one, with string-built SQL.

## How it works

```
Shopify ──webhook──> POST /webhooks/shopify   verify HMAC, insert webhook_events (unique webhook_id),
                                              insert job, return 200. nothing else.
                              │
Merchant ──API key──> POST /api/campaigns/trigger
                              │               pick eligible customers, insert campaign_sends + jobs
                              │               in one transaction, return 202
                              ▼
                        jobs table (postgres, FOR UPDATE SKIP LOCKED)
                              │
                           worker(s)
            ┌─────────────────┼──────────────────────┐
     orders/create      inventory_levels/update    send_winback
     upsert customer    upsert stock (only if      stock check -> LLM (timeout, breaker,
     + attribution      newer updated_at)          template fallback) -> stock check again
                                                   -> email (idempotency key) -> mark sent
```

Some decisions:

- **Queue in Postgres, not Redis.** One less thing to run, and jobs are inserted in the same
  transaction as the rows they point to. At ~500 stores this is plenty. If it ever isn't,
  `queue.js` is the only file that would change (BullMQ/SQS).
- **Duplicates are handled by unique constraints**, not by "check then insert":
  `webhook_events.webhook_id`, `campaign_sends (campaign_id, customer_id)`,
  `attributions (merchant_id, shopify_order_id)`, `campaigns (merchant_id, idempotency_key)`.
- **Email idempotency key = campaign_send id.** If the worker dies after the provider accepted the
  email but before we saved `sent`, the retry is deduped by the provider.
- **LLM is optional for a send.** Timeout 8s, circuit breaker, and if the output is empty, too long or
  doesn't contain the code we use a plain template. A slow LLM never stops emails going out.
- **Stock is checked twice**: before generating (out of stock product isn't passed to the LLM at all)
  and right before sending (sold out in between -> swap to template).
- **Tenant comes from the API key**, never from the request body. Every query filters by `merchant_id`.

## Running

```bash
cp .env.example .env
docker compose up -d          # postgres, loads db/schema.sql on first start
npm install
npm start                     # api
npm run worker                # worker, run as many as you want
npm test
```

Create a merchant (the API key is stored hashed):

```bash
node -e "console.log(require('./src/auth').hashKey('my-secret-key'))"
psql $DATABASE_URL -c "insert into merchants (shop_domain, name, api_key_hash, from_email)
  values ('my-store.myshopify.com', 'My Store', '<hash>', 'hello@mystore.com')"
```

Trigger a campaign:

```bash
curl -X POST localhost:3000/api/campaigns/trigger \
  -H "Authorization: Bearer my-secret-key" \
  -H "Idempotency-Key: oct-winback-1" \
  -H "Content-Type: application/json" \
  -d '{"discountCode": "COMEBACK15"}'
# 202 {"campaignId": 1, "queued": 340}
```

## Assumptions / not done yet

- `variants` (variant -> inventory item + title) is filled by a catalog sync that isn't here.
- The email provider supports an `Idempotency-Key` header. If it doesn't, keep a "sending" lock
  and accept a small at-least-once risk.
- Attribution = order uses the campaign's code within 14 days of the email. Simple and easy to explain
  to a merchant; no multi-touch.
- Discount codes are trusted from the merchant; ideally check they exist in Shopify first.
- No per-merchant rate limit on the LLM yet, only the global worker concurrency.
- Unit tests use a fake db. The SQL was also run end to end against a real Postgres 17 locally.
