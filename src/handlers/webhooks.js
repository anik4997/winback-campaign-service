// These run inside a transaction (see worker.js), so if anything throws
// nothing is half written and the job is simply retried.

const ATTRIBUTION_WINDOW_DAYS = 14;

function isSubscribed(customer) {
  if (customer.email_marketing_consent) {
    return customer.email_marketing_consent.state === 'subscribed';
  }
  return customer.accepts_marketing === true;
}

async function handleOrderCreated(client, merchantId, order) {
  const c = order.customer;
  if (!c || !c.id) return; // guest checkout, nothing to track

  const orderedAt = order.created_at || new Date().toISOString();
  const firstLine = (order.line_items || [])[0];

  const { rows } = await client.query(
    `insert into customers
       (merchant_id, shopify_customer_id, email, first_name, marketing_opt_in, orders_count, last_order_at, last_variant_id)
     values ($1, $2, $3, $4, $5, 1, $6, $7)
     on conflict (merchant_id, shopify_customer_id) do update set
       email            = coalesce(excluded.email, customers.email),
       first_name       = coalesce(excluded.first_name, customers.first_name),
       marketing_opt_in = excluded.marketing_opt_in,
       orders_count     = customers.orders_count + 1,
       last_variant_id  = case
                            when customers.last_order_at is null or excluded.last_order_at >= customers.last_order_at
                            then excluded.last_variant_id else customers.last_variant_id
                          end,
       last_order_at    = greatest(customers.last_order_at, excluded.last_order_at)
     returning id`,
    [
      merchantId,
      c.id,
      c.email || order.email || null,
      c.first_name || null,
      isSubscribed(c),
      orderedAt,
      firstLine ? firstLine.variant_id : null,
    ]
  );
  const customerId = rows[0].id;

  const codes = (order.discount_codes || []).map((d) => String(d.code).toUpperCase());
  if (!codes.length) return;

  // Attribute the order to the latest win-back email this customer got, only if they
  // used that campaign's code within the window. Unique (merchant_id, shopify_order_id)
  // means a replayed order can't add revenue twice.
  await client.query(
    `insert into attributions (merchant_id, campaign_send_id, shopify_order_id, revenue, currency, ordered_at)
     select $1, cs.id, $3, $4, $5, $6
       from campaign_sends cs
       join campaigns c on c.id = cs.campaign_id
      where cs.merchant_id = $1
        and cs.customer_id = $2
        and cs.status = 'sent'
        and cs.sent_at between $6::timestamptz - make_interval(days => $8) and $6::timestamptz
        and upper(c.discount_code) = any($7::text[])
      order by cs.sent_at desc
      limit 1
     on conflict (merchant_id, shopify_order_id) do nothing`,
    [merchantId, customerId, order.id, order.total_price, order.currency, orderedAt, codes, ATTRIBUTION_WINDOW_DAYS]
  );
}

async function handleInventoryUpdate(client, merchantId, level) {
  // only apply if newer than what we have, webhooks can arrive out of order
  await client.query(
    `insert into inventory_levels (merchant_id, inventory_item_id, location_id, available, updated_at)
     values ($1, $2, $3, $4, $5)
     on conflict (merchant_id, inventory_item_id, location_id) do update set
       available = excluded.available,
       updated_at = excluded.updated_at
     where inventory_levels.updated_at < excluded.updated_at`,
    [merchantId, level.inventory_item_id, level.location_id, level.available, level.updated_at || new Date().toISOString()]
  );
}

module.exports = { handleOrderCreated, handleInventoryUpdate, isSubscribed };
