const test = require('node:test');
const assert = require('node:assert');
const { CircuitBreaker } = require('../src/clients/circuitBreaker');

test('opens after threshold failures and fails fast', async () => {
  let now = 1000;
  const cb = new CircuitBreaker('x', { threshold: 2, cooldownMs: 500, now: () => now });
  let calls = 0;
  const boom = async () => { calls++; throw new Error('down'); };

  await assert.rejects(cb.call(boom));
  await assert.rejects(cb.call(boom));
  await assert.rejects(cb.call(boom), /circuit open/);
  assert.equal(calls, 2);

  now += 600;
  assert.equal(await cb.call(async () => 'ok'), 'ok');
});

test('permanent errors do not open the circuit', async () => {
  const cb = new CircuitBreaker('x', { threshold: 1 });
  const err = new Error('bad email');
  err.permanent = true;
  await assert.rejects(cb.call(async () => { throw err; }), /bad email/);
  assert.equal(cb.isOpen(), false);
});
