const llm = require('../clients/llm');
const email = require('../clients/email');
const { PermanentError } = require('../queue');

const defaultDeps = {
  generateCopy: llm.generateCopy,
  sendEmail: email.sendEmail,
};

async function loadSend(db, sendId) {
  const { rows } = await db.query(
    `select cs.id, cs.status, cs.merchant_id, cs.message_body, cs.product_mentioned,
            c.email, c.first_name, c.marketing_opt_in,
            camp.discount_code,
            m.name as store_name, m.from_email,
            v.product_title, v.inventory_item_id
       from campaign_sends cs
       join customers c    on c.id = cs.customer_id and c.merchant_id = cs.merchant_id
       join campaigns camp on camp.id = cs.campaign_id and camp.merchant_id = cs.merchant_id
       join merchants m    on m.id = cs.merchant_id
       left join variants v on v.merchant_id = cs.merchant_id and v.shopify_variant_id = c.last_variant_id
      where cs.id = $1`,
    [sendId]
  );
  return rows[0];
}

// no inventory rows at all = we don't know, so treat as not available rather than risk it
async function isInStock(db, merchantId, inventoryItemId) {
  const { rows } = await db.query(
    `select count(*)::int as levels,
            coalesce(sum(available), 0)::int as available,
            coalesce(bool_or(available is null), false) as untracked
       from inventory_levels
      where merchant_id = $1 and inventory_item_id = $2`,
    [merchantId, inventoryItemId]
  );
  const r = rows[0];
  if (!r || r.levels === 0) return false;
  return r.untracked || r.available > 0;
}

function fallbackCopy({ firstName, storeName, discountCode }) {
  const hi = firstName ? `Hi ${firstName},` : 'Hi there,';
  return `${hi}\n\nIt's been a while and we miss you at ${storeName}! ` +
    `Here's a little something to welcome you back: use code ${discountCode} on your next order.\n\n` +
    `See you soon,\nThe ${storeName} team`;
}

function isUsableCopy(text, discountCode) {
  return Boolean(text) && text.length <= 1500 && text.includes(discountCode);
}

async function handleSendWinback(job, db, deps = defaultDeps) {
  const send = await loadSend(db, job.payload.sendId);
  if (!send) throw new PermanentError('campaign send not found');

  // already done (job retried / duplicated) -> nothing to do
  if (['sent', 'skipped', 'failed'].includes(send.status)) return;

  if (!send.email || !send.marketing_opt_in) {
    await db.query(`update campaign_sends set status = 'skipped', stock_note = 'no_consent' where id = $1`, [send.id]);
    return;
  }

  const base = {
    firstName: send.first_name,
    storeName: send.store_name,
    discountCode: send.discount_code,
  };

  let body = send.message_body;
  let productMentioned = send.product_mentioned;
  let usedFallback = false;
  let stockNote = null;

  // check #1: before generating. only give the LLM the product if it's actually in stock
  if (!body) {
    let productTitle = null;
    if (send.product_title) {
      if (await isInStock(db, send.merchant_id, send.inventory_item_id)) {
        productTitle = send.product_title;
      } else {
        stockNote = 'out_of_stock';
      }
    }

    try {
      body = await deps.generateCopy({ ...base, productTitle });
    } catch (err) {
      console.warn(`send ${send.id}: llm failed (${err.message}), using template`);
      body = null;
    }

    if (!isUsableCopy(body, send.discount_code)) {
      body = fallbackCopy(base);
      usedFallback = true;
      productMentioned = false;
    } else {
      productMentioned = Boolean(productTitle);
    }

    // save the copy so a retry (e.g. email api down) doesn't pay for another llm call
    await db.query(
      `update campaign_sends
          set status = 'sending', message_body = $2, product_mentioned = $3,
              used_fallback_copy = $4, stock_note = $5
        where id = $1`,
      [send.id, body, productMentioned, usedFallback, stockNote]
    );
  }

  // check #2: right before sending. stock can sell out between generating and sending
  // (or between a failed attempt and its retry). don't regenerate, just switch to the safe template
  if (productMentioned && !(await isInStock(db, send.merchant_id, send.inventory_item_id))) {
    body = fallbackCopy(base);
    await db.query(
      `update campaign_sends
          set message_body = $2, product_mentioned = false, used_fallback_copy = true, stock_note = 'sold_out_before_send'
        where id = $1`,
      [send.id, body]
    );
  }

  const result = await deps.sendEmail({
    from: send.from_email,
    to: send.email,
    subject: `We miss you at ${send.store_name}`,
    text: body,
    idempotencyKey: `winback-send-${send.id}`,
  });

  await db.query(
    `update campaign_sends set status = 'sent', sent_at = now(), provider_message_id = $2 where id = $1`,
    [send.id, result.messageId]
  );
}

module.exports = { handleSendWinback, isInStock, fallbackCopy, isUsableCopy };
