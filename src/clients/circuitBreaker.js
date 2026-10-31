// Tiny circuit breaker. After `threshold` failures in a row we stop calling the service
// for `cooldownMs`, so a dead provider fails fast instead of every job waiting on a timeout.
class CircuitBreaker {
  constructor(name, { threshold = 5, cooldownMs = 30_000, now = Date.now } = {}) {
    this.name = name;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.failures = 0;
    this.openUntil = 0;
  }

  isOpen() {
    return this.now() < this.openUntil;
  }

  async call(fn) {
    if (this.isOpen()) {
      const err = new Error(`${this.name} circuit open`);
      err.circuitOpen = true;
      throw err;
    }
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (err) {
      // a permanent error (bad request, invalid email) means the service is up, don't count it
      if (err.permanent) throw err;
      this.failures++;
      if (this.failures >= this.threshold) {
        this.openUntil = this.now() + this.cooldownMs;
        this.failures = 0;
      }
      throw err;
    }
  }
}

module.exports = { CircuitBreaker };
