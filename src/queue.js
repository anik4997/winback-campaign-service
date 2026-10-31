// Simple job queue on top of postgres.
// Using the same db as the app means a job can be inserted in the same transaction
// as the data it refers to, so we never get a webhook saved without its job (or the opposite).

class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

async function enqueue(db, type, payload, opts = {}) {
  const { rows } = await db.query(
    `insert into jobs (type, payload, max_attempts) values ($1, $2, $3) returning id`,
    [type, payload, opts.maxAttempts || 5]
  );
  return rows[0].id;
}

// grab up to `limit` jobs, skip locked so several workers can run side by side
async function claimJobs(db, limit) {
  const { rows } = await db.query(
    `update jobs
        set status = 'running', locked_at = now(), attempts = attempts + 1
      where id in (
        select id from jobs
         where status = 'queued' and run_at <= now()
         order by run_at
         limit $1
         for update skip locked
      )
      returning *`,
    [limit]
  );
  return rows;
}

async function completeJob(db, id) {
  await db.query(`update jobs set status = 'done', locked_at = null where id = $1`, [id]);
}

function backoffSeconds(attempts) {
  // 10s, 40s, 90s, 160s ... capped at 15 min
  return Math.min(10 * attempts * attempts, 900);
}

// returns true if the job is dead (no more retries)
async function failJob(db, job, err) {
  const dead = err.permanent || job.attempts >= job.max_attempts;
  const msg = String(err.message || err).slice(0, 1000);

  if (dead) {
    await db.query(
      `update jobs set status = 'dead', locked_at = null, last_error = $2 where id = $1`,
      [job.id, msg]
    );
  } else {
    await db.query(
      `update jobs
          set status = 'queued', locked_at = null, last_error = $2,
              run_at = now() + make_interval(secs => $3)
        where id = $1`,
      [job.id, msg, backoffSeconds(job.attempts)]
    );
  }
  return dead;
}

// worker crashed mid job -> put it back
async function requeueStuckJobs(db, olderThanMinutes = 5) {
  const { rowCount } = await db.query(
    `update jobs set status = 'queued', locked_at = null
      where status = 'running' and locked_at < now() - make_interval(mins => $1)`,
    [olderThanMinutes]
  );
  return rowCount;
}

module.exports = {
  PermanentError,
  enqueue,
  claimJobs,
  completeJob,
  failJob,
  backoffSeconds,
  requeueStuckJobs,
};
