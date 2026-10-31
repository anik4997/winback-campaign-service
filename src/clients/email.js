const { CircuitBreaker } = require('./circuitBreaker');
const { PermanentError } = require('../queue');

const breaker = new CircuitBreaker('email', { threshold: 5, cooldownMs: 60_000 });

// Assumes the provider supports an Idempotency-Key header (Postmark/Resend/SES-style).
// We pass the campaign_send id, so if we crash after sending but before saving 'sent',
// the retry is deduped by the provider instead of mailing the customer twice.
async function sendEmail({ from, to, subject, text, idempotencyKey }, { fetchImpl = fetch } = {}) {
  return breaker.call(async () => {
    const res = await fetchImpl(process.env.EMAIL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ from, to, subject, text }),
      signal: AbortSignal.timeout(Number(process.env.EMAIL_TIMEOUT_MS || 10000)),
    });

    // 4xx (bad address etc) won't get better with a retry, 429/5xx will
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new PermanentError(`email rejected: http ${res.status}`);
    }
    if (!res.ok) throw new Error(`email http ${res.status}`);

    const body = await res.json().catch(() => ({}));
    return { messageId: body.id || body.MessageID || null };
  });
}

module.exports = { sendEmail, breaker };
