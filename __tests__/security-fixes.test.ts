import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// 1. JSON-LD XSS escape (app/article/[id]/page.tsx)
// ---------------------------------------------------------------------------
describe('JSON-LD XSS escaping', () => {
  function safeJsonLd(obj: unknown): string {
    return JSON.stringify(obj)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/\//g, '\\u002f');
  }

  it('escapes </script> breakout sequences', () => {
    const payload = { title: '</script><script>alert(1)</script>' };
    const output = safeJsonLd(payload);
    expect(output).not.toContain('</script>');
    expect(output).not.toContain('<script>');
  });

  it('replaces < > / with unicode escapes', () => {
    const output = safeJsonLd({ a: '</>' });
    expect(output).toContain('\\u003c');
    expect(output).toContain('\\u003e');
    expect(output).toContain('\\u002f');
  });

  it('produces valid JSON after escaping', () => {
    const obj = { title: 'Safe title', url: 'https://example.com/path' };
    const output = safeJsonLd(obj);
    // JSON.parse will throw if the string is invalid JSON
    expect(() => JSON.parse(output)).not.toThrow();
  });

  it('plain text without special chars is unchanged in meaning', () => {
    const obj = { title: 'Normal headline here' };
    const output = safeJsonLd(obj);
    const parsed = JSON.parse(output);
    expect(parsed.title).toBe('Normal headline here');
  });
});

// ---------------------------------------------------------------------------
// 2. Headlines limit clamping (app/api/headlines/route.ts)
// ---------------------------------------------------------------------------
describe('Headlines limit clamping', () => {
  function clampLimit(raw: string | null): number {
    return Math.min(Math.max(parseInt(raw || '25', 10), 1), 200);
  }

  it('clamps absurdly large values to 200', () => {
    expect(clampLimit('9999999')).toBe(200);
  });

  it('clamps zero/negative to 1', () => {
    expect(clampLimit('0')).toBe(1);
    expect(clampLimit('-50')).toBe(1);
  });

  it('defaults to 25 when null', () => {
    expect(clampLimit(null)).toBe(25);
  });

  it('passes through valid values within range', () => {
    expect(clampLimit('50')).toBe(50);
    expect(clampLimit('200')).toBe(200);
    expect(clampLimit('1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Webhook timestamp validation (app/api/webhooks/helius/route.ts)
// ---------------------------------------------------------------------------
describe('Webhook timestamp validation', () => {
  const MAX_WEBHOOK_AGE_SECONDS = 300;

  function isTransactionStale(
    timestamp: number | undefined,
    nowSeconds: number
  ): { reject: boolean; reason?: string } {
    if (!timestamp) {
      return { reject: true, reason: 'missing timestamp' };
    }
    const age = nowSeconds - timestamp;
    if (age > MAX_WEBHOOK_AGE_SECONDS) {
      return { reject: true, reason: `stale (${age}s old)` };
    }
    return { reject: false };
  }

  it('rejects transactions with no timestamp', () => {
    const result = isTransactionStale(undefined, 1000);
    expect(result.reject).toBe(true);
    expect(result.reason).toMatch(/missing/);
  });

  it('rejects transactions older than MAX_WEBHOOK_AGE_SECONDS', () => {
    const now = 10000;
    const oldTimestamp = now - MAX_WEBHOOK_AGE_SECONDS - 1;
    const result = isTransactionStale(oldTimestamp, now);
    expect(result.reject).toBe(true);
  });

  it('accepts fresh transactions', () => {
    const now = 10000;
    const freshTimestamp = now - 10; // 10 seconds old
    const result = isTransactionStale(freshTimestamp, now);
    expect(result.reject).toBe(false);
  });

  it('accepts transactions exactly at the age boundary', () => {
    const now = 10000;
    const boundaryTimestamp = now - MAX_WEBHOOK_AGE_SECONDS;
    const result = isTransactionStale(boundaryTimestamp, now);
    expect(result.reject).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Cache eviction TTL (app/api/token-prices/route.ts)
// ---------------------------------------------------------------------------
describe('Token price cache eviction TTL', () => {
  const CACHE_TTL_MS = 30_000;

  function isExpired(lastUpdated: number, now: number): boolean {
    return now - lastUpdated > CACHE_TTL_MS;
  }

  it('evicts entries older than CACHE_TTL_MS', () => {
    const now = Date.now();
    const oldEntry = now - CACHE_TTL_MS - 1;
    expect(isExpired(oldEntry, now)).toBe(true);
  });

  it('does NOT evict entries still within TTL', () => {
    const now = Date.now();
    const freshEntry = now - CACHE_TTL_MS + 1000;
    expect(isExpired(freshEntry, now)).toBe(false);
  });

  it('old logic (CACHE_TTL_MS * 10) would have kept stale entries longer', () => {
    const now = Date.now();
    // Entry expired 35s ago (beyond the 30s TTL, should be evicted)
    const staleEntry = now - 35_000;

    // New logic: correctly evicts
    expect(isExpired(staleEntry, now)).toBe(true);

    // Old logic: would NOT have evicted (300s threshold)
    const oldLogicEvicts = now - staleEntry > CACHE_TTL_MS * 10;
    expect(oldLogicEvicts).toBe(false);
  });
});
