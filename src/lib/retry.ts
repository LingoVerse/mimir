// Retry helper for transient LLM provider errors (429 rate-limit, 503
// service-unavailable, network blips). Exponential backoff with jitter.
// Wraps any async fn; does NOT retry non-retryable errors (4xx except 429).

function isRetryable(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("fetch failed")
  );
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; baseDelayMs?: number },
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 2000;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) throw err;
      const jitter = Math.random() * 200;
      const delay = Math.min(baseDelay * Math.pow(2, attempt) + jitter, 15_000);
      console.warn(
        `[mimir] retry ${attempt + 1}/${maxRetries} after ${delay.toFixed(0)}ms`,
        String(err).slice(0, 200),
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
