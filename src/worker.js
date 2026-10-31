require('dotenv').config();
const { pool, withTransaction } = require('./db');
const queue = require('./queue');
const { handleOrderCreated, handleInventoryUpdate } = require('./handlers/webhooks');
const { handleSendWinback } = require('./handlers/sendWinback');

// wraps a webhook handler: load the stored event, run handler in a transaction
function webhookJob(fn) {
  return (job, db) =>
    withTransaction(db, async (client) => {
      const ev = await client.query('select merchant_id, payload from webhook_events where id = $1', [
        job.payload.eventId,
      ]);
      if (!ev.rows.length) throw new queue.PermanentError('webhook event not found');
      await fn(client, ev.rows[0].merchant_id, ev.rows[0].payload);
    });
}

const handlers = {
  'orders/create': webhookJob(handleOrderCreated),
  'inventory_levels/update': webhookJob(handleInventoryUpdate),
  send_winback: (job, db) => handleSendWinback(job, db),
};

async function runJob(db, job) {
  const handler = handlers[job.type];
  try {
    if (!handler) throw new queue.PermanentError(`no handler for ${job.type}`);
    await handler(job, db);
    await queue.completeJob(db, job.id);
  } catch (err) {
    const dead = await queue.failJob(db, job, err);
    if (dead && job.type === 'send_winback') {
      await db.query(
        `update campaign_sends set status = 'failed' where id = $1 and status in ('pending', 'sending')`,
        [job.payload.sendId]
      );
    }
    console.error(`job ${job.id} (${job.type}) failed, attempt ${job.attempts}${dead ? ', giving up' : ''}:`, err.message);
  }
}

let stopping = false;

async function loop(db) {
  const concurrency = Number(process.env.WORKER_CONCURRENCY || 10);
  let lastReap = 0;

  while (!stopping) {
    if (Date.now() - lastReap > 60_000) {
      await queue.requeueStuckJobs(db).catch((e) => console.error('requeue failed', e.message));
      lastReap = Date.now();
    }

    let jobs = [];
    try {
      jobs = await queue.claimJobs(db, concurrency);
    } catch (err) {
      console.error('claim failed', err.message);
    }

    if (!jobs.length) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    await Promise.allSettled(jobs.map((job) => runJob(db, job)));
  }
}

if (require.main === module) {
  process.on('SIGTERM', () => (stopping = true));
  process.on('SIGINT', () => (stopping = true));
  console.log('worker started');
  loop(pool).then(() => pool.end());
}

module.exports = { runJob, handlers };
