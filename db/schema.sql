-- every table that holds merchant data has merchant_id, and every query filters on it

create table if not exists merchants (
  id            bigserial primary key,
  shop_domain   text not null unique,          -- e.g. my-store.myshopify.com
  name          text not null,
  api_key_hash  text not null unique,          -- sha256 of the merchant api key, never store the raw key
  from_email    text not null,
  created_at    timestamptz not null default now()
);

create table if not exists customers (
  id                  bigserial primary key,
  merchant_id         bigint not null references merchants(id),
  shopify_customer_id bigint not null,
  email               text,
  first_name          text,
  marketing_opt_in    boolean not null default false,
  orders_count        int not null default 0,
  last_order_at       timestamptz,
  last_variant_id     bigint,                  -- variant from their latest order, used for personalisation
  unique (merchant_id, shopify_customer_id)
);
create index if not exists customers_inactive_idx on customers (merchant_id, last_order_at);

-- filled by a catalog sync (products webhook / admin api), not part of this service yet
create table if not exists variants (
  merchant_id        bigint not null references merchants(id),
  shopify_variant_id bigint not null,
  inventory_item_id  bigint not null,
  product_title      text not null,
  primary key (merchant_id, shopify_variant_id)
);

create table if not exists inventory_levels (
  merchant_id       bigint not null references merchants(id),
  inventory_item_id bigint not null,
  location_id       bigint not null,
  available         int,                       -- null = shopify doesn't track stock for this item
  updated_at        timestamptz not null,      -- shopify's updated_at, so old webhooks can't overwrite newer stock
  primary key (merchant_id, inventory_item_id, location_id)
);

-- raw webhooks. unique webhook_id = shopify retries/duplicates are dropped on insert
create table if not exists webhook_events (
  id          bigserial primary key,
  merchant_id bigint not null references merchants(id),
  webhook_id  text not null unique,            -- X-Shopify-Webhook-Id
  topic       text not null,
  payload     jsonb not null,
  received_at timestamptz not null default now()
);

create table if not exists jobs (
  id           bigserial primary key,
  type         text not null,
  payload      jsonb not null,
  status       text not null default 'queued',  -- queued | running | done | dead
  attempts     int not null default 0,
  max_attempts int not null default 5,
  run_at       timestamptz not null default now(),
  locked_at    timestamptz,
  last_error   text,
  created_at   timestamptz not null default now()
);
create index if not exists jobs_pick_idx on jobs (run_at) where status = 'queued';

create table if not exists campaigns (
  id              bigserial primary key,
  merchant_id     bigint not null references merchants(id),
  discount_code   text not null,
  idempotency_key text,
  created_at      timestamptz not null default now(),
  unique (merchant_id, idempotency_key)
);

create table if not exists campaign_sends (
  id                  bigserial primary key,
  campaign_id         bigint not null references campaigns(id),
  merchant_id         bigint not null references merchants(id),
  customer_id         bigint not null references customers(id),
  status              text not null default 'pending', -- pending | sending | sent | skipped | failed
  used_fallback_copy  boolean not null default false,
  product_mentioned   boolean not null default false,
  stock_note          text,                            -- why the product was dropped from the copy / why it was skipped
  message_body        text,
  provider_message_id text,
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  unique (campaign_id, customer_id)
);
create index if not exists campaign_sends_customer_idx on campaign_sends (merchant_id, customer_id, sent_at);

-- one row per order max, so a duplicate orders/create can never double count revenue
create table if not exists attributions (
  id               bigserial primary key,
  merchant_id      bigint not null references merchants(id),
  campaign_send_id bigint not null references campaign_sends(id),
  shopify_order_id bigint not null,
  revenue          numeric(12, 2) not null,
  currency         text not null,
  ordered_at       timestamptz not null,
  unique (merchant_id, shopify_order_id)
);
