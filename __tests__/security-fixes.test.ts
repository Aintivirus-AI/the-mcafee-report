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
// NEW: API key empty-string bypass (app/api/admin/mayhem/route.ts)
// ---------------------------------------------------------------------------
describe('API key empty-string bypass prevention', () => {
  function isAuthorized(apiKey: string | undefined, incomingKey: string | null): boolean {
    if (!apiKey) return false;
    if (!incomingKey) return false;
    // Simulate safeCompare (same length required for timing-safe)
    if (incomingKey.length !== apiKey.length) return false;
    return incomingKey === apiKey; // simplified for unit test
  }

  it('rejects when API_KEY is undefined (no env var set)', () => {
    expect(isAuthorized(undefined, '')).toBe(false);
    expect(isAuthorized(undefined, 'anykey')).toBe(false);
  });

  it('rejects when API_KEY is empty string (old fallback behaviour)', () => {
    expect(isAuthorized('', '')).toBe(false);
  });

  it('rejects when incoming key is empty and API_KEY is set', () => {
    expect(isAuthorized('secretkey', '')).toBe(false);
  });

  it('accepts valid matching key', () => {
    expect(isAuthorized('secretkey', 'secretkey')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NEW: Webhook Bearer format enforcement (app/api/webhooks/helius/route.ts)
// ---------------------------------------------------------------------------
describe('Webhook Bearer format enforcement', () => {
  function verifyAuthHeader(authHeader: string | null, webhookSecret: string): boolean {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);
    return token === webhookSecret;
  }

  it('rejects bare secret (no Bearer prefix)', () => {
    expect(verifyAuthHeader('mysecret', 'mysecret')).toBe(false);
  });

  it('rejects empty header', () => {
    expect(verifyAuthHeader(null, 'mysecret')).toBe(false);
    expect(verifyAuthHeader('', 'mysecret')).toBe(false);
  });

  it('rejects wrong Bearer token', () => {
    expect(verifyAuthHeader('Bearer wrongtoken', 'mysecret')).toBe(false);
  });

  it('accepts correct Bearer token', () => {
    expect(verifyAuthHeader('Bearer mysecret', 'mysecret')).toBe(true);
  });

  it('rejects "Bearer " with empty token against non-empty secret', () => {
    expect(verifyAuthHeader('Bearer ', 'mysecret')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NEW: VOTER_HASH_SALT domain coupling (app/api/votes/route.ts)
// ---------------------------------------------------------------------------
describe('VOTER_HASH_SALT domain decoupling', () => {
  function getVoterHashSalt(env: { VOTER_HASH_SALT?: string; API_SECRET_KEY?: string }): string {
    // Old (broken) behaviour: falls back to API_SECRET_KEY
    return env.VOTER_HASH_SALT || env.API_SECRET_KEY || 'default-voter-salt';
  }

  function getVoterHashSaltFixed(env: { VOTER_HASH_SALT?: string }): string {
    if (!env.VOTER_HASH_SALT) throw new Error('VOTER_HASH_SALT env var is required');
    return env.VOTER_HASH_SALT;
  }

  it('old behaviour silently uses API_SECRET_KEY when VOTER_HASH_SALT is missing', () => {
    const salt = getVoterHashSalt({ API_SECRET_KEY: 'api-key-value' });
    expect(salt).toBe('api-key-value'); // dangerous coupling
  });

  it('fixed behaviour throws when VOTER_HASH_SALT is missing', () => {
    expect(() => getVoterHashSaltFixed({})).toThrow('VOTER_HASH_SALT env var is required');
  });

  it('fixed behaviour returns VOTER_HASH_SALT when set', () => {
    expect(getVoterHashSaltFixed({ VOTER_HASH_SALT: 'my-salt' })).toBe('my-salt');
  });
});

// ---------------------------------------------------------------------------
// NEW: WALLET_ENCRYPTION_KEY guard (lib/secrets-provider.ts)
// ---------------------------------------------------------------------------
describe('WALLET_ENCRYPTION_KEY guard', () => {
  function decryptFromEnvSimulated(env: {
    MASTER_WALLET_ENCRYPTED_KEY?: string;
    WALLET_ENCRYPTION_KEY?: string;
  }): string {
    if (!env.MASTER_WALLET_ENCRYPTED_KEY) {
      throw new Error('MASTER_WALLET_ENCRYPTED_KEY env var is required when WALLET_SECRET_PROVIDER=encrypted');
    }
    if (!env.WALLET_ENCRYPTION_KEY) {
      throw new Error('WALLET_ENCRYPTION_KEY env var is required when WALLET_SECRET_PROVIDER=encrypted');
    }
    return 'decrypted'; // stub
  }

  it('throws clear error when WALLET_ENCRYPTION_KEY is missing', () => {
    expect(() =>
      decryptFromEnvSimulated({ MASTER_WALLET_ENCRYPTED_KEY: 'enc-data' })
    ).toThrow('WALLET_ENCRYPTION_KEY env var is required');
  });

  it('throws clear error when MASTER_WALLET_ENCRYPTED_KEY is missing', () => {
    expect(() =>
      decryptFromEnvSimulated({ WALLET_ENCRYPTION_KEY: 'a'.repeat(64) })
    ).toThrow('MASTER_WALLET_ENCRYPTED_KEY env var is required');
  });

  it('succeeds when both vars are present', () => {
    expect(() =>
      decryptFromEnvSimulated({
        MASTER_WALLET_ENCRYPTED_KEY: 'enc-data',
        WALLET_ENCRYPTION_KEY: 'a'.repeat(64),
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// NEW: IP extraction whitespace fix (app/api/token-prices/route.ts)
// ---------------------------------------------------------------------------
describe('IP extraction from x-forwarded-for', () => {
  function extractIp(header: string | null): string {
    const rawIp = header?.split(',')[0]?.trim();
    return (rawIp && rawIp.length > 0) ? rawIp : 'unknown';
  }

  it('returns "unknown" for whitespace-only header (old || would use "unknown" too, but via different path)', () => {
    expect(extractIp('   ')).toBe('unknown');
    expect(extractIp('\t')).toBe('unknown');
  });

  it('returns "unknown" for null header', () => {
    expect(extractIp(null)).toBe('unknown');
  });

  it('extracts first IP from comma-separated list', () => {
    expect(extractIp('1.2.3.4, 5.6.7.8')).toBe('1.2.3.4');
  });

  it('trims whitespace around IP', () => {
    expect(extractIp('  1.2.3.4  ')).toBe('1.2.3.4');
  });

  it('returns single IP when no comma present', () => {
    expect(extractIp('192.168.1.1')).toBe('192.168.1.1');
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

// ---------------------------------------------------------------------------
// 5. NaN Content-Length bypass (lib/url-validator.ts fix)
// ---------------------------------------------------------------------------
describe('NaN Content-Length bypass prevention', () => {
  function isContentLengthTooLarge(contentLength: string, maxBytes: number): boolean {
    const clLen = parseInt(contentLength, 10);
    return !Number.isFinite(clLen) || clLen > maxBytes;
  }

  const MAX = 2 * 1024 * 1024;

  it('malformed header produces NaN and is now rejected', () => {
    // Before fix: NaN > MAX = false → passed. After fix: !isFinite(NaN) = true → rejected
    expect(isContentLengthTooLarge('abc', MAX)).toBe(true);
  });

  it('oversized response is rejected', () => {
    expect(isContentLengthTooLarge(String(MAX + 1), MAX)).toBe(true);
  });

  it('valid response within limit is accepted', () => {
    expect(isContentLengthTooLarge('1024', MAX)).toBe(false);
  });

  it('demonstrates old bug: NaN > maxBytes = false (was silently bypassed)', () => {
    const nan = parseInt('not-a-number', 10);
    expect(Number.isNaN(nan)).toBe(true);
    expect(nan > MAX).toBe(false); // This is why the old guard failed
  });
});

// ---------------------------------------------------------------------------
// 6. Positive Content-Length validation (app/api/comments/route.ts fix)
// ---------------------------------------------------------------------------
describe('Positive Content-Length validation', () => {
  const MAX_BODY_SIZE = 1_000_000;

  function isInvalidContentLength(header: string): boolean {
    const len = parseInt(header, 10);
    return len <= 0 || len > MAX_BODY_SIZE;
  }

  it('negative Content-Length is now rejected', () => {
    expect(isInvalidContentLength('-1')).toBe(true);
  });

  it('zero Content-Length is rejected', () => {
    expect(isInvalidContentLength('0')).toBe(true);
  });

  it('oversized Content-Length is rejected', () => {
    expect(isInvalidContentLength(String(MAX_BODY_SIZE + 1))).toBe(true);
  });

  it('valid Content-Length passes', () => {
    expect(isInvalidContentLength('500')).toBe(false);
    expect(isInvalidContentLength(String(MAX_BODY_SIZE))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Headline ID strict validation (app/api/votes/route.ts fix)
// ---------------------------------------------------------------------------
describe('Headline ID strict validation', () => {
  function isValidHeadlineIdStr(s: string): boolean {
    return /^\d+$/.test(s);
  }

  it('pure integer string is valid', () => {
    expect(isValidHeadlineIdStr('123')).toBe(true);
    expect(isValidHeadlineIdStr('1')).toBe(true);
  });

  it('decimal string is rejected — was previously truncated silently', () => {
    expect(isValidHeadlineIdStr('123.45abc')).toBe(false);
    expect(isValidHeadlineIdStr('123.45')).toBe(false);
  });

  it('negative and empty strings are rejected', () => {
    expect(isValidHeadlineIdStr('-1')).toBe(false);
    expect(isValidHeadlineIdStr('')).toBe(false);
  });

  it('POST body uses Number.isInteger for exact integer check', () => {
    expect(Number.isInteger(Number(123)) && Number(123) > 0).toBe(true);
    expect(Number.isInteger(Number(123.45))).toBe(false);
    expect(Number.isInteger(Number('123.45abc'))).toBe(false); // NaN
  });
});

// ---------------------------------------------------------------------------
// 8. Integer overflow guard (lib/wallet-guardrails.ts fix)
// ---------------------------------------------------------------------------
describe('Daily outflow integer overflow guard', () => {
  function wouldOverflow(dailyOutflow: number, lamports: number): boolean {
    return !Number.isSafeInteger(dailyOutflow + lamports);
  }

  it('safe values do not trigger overflow guard', () => {
    expect(wouldOverflow(1_000_000, 500_000)).toBe(false);
  });

  it('values exceeding MAX_SAFE_INTEGER trigger the guard', () => {
    expect(wouldOverflow(Number.MAX_SAFE_INTEGER, 1)).toBe(true);
  });

  it('normal SOL amounts in lamports are safe', () => {
    const tenSol = 10 * 1_000_000_000;
    expect(wouldOverflow(0, tenSol)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. CSRF origin fail-safe (app/api/scheduler/trigger/route.ts fix)
// ---------------------------------------------------------------------------
describe('CSRF origin check fail-safe when NEXT_PUBLIC_SITE_URL unset', () => {
  function isCsrfBlocked(origin: string | null, siteUrl: string | undefined): boolean {
    return origin !== null && (!siteUrl || origin !== siteUrl);
  }

  it('no Origin header → allowed regardless of siteUrl config', () => {
    expect(isCsrfBlocked(null, undefined)).toBe(false);
    expect(isCsrfBlocked(null, 'https://example.com')).toBe(false);
  });

  it('matching origin + configured siteUrl → allowed', () => {
    expect(isCsrfBlocked('https://example.com', 'https://example.com')).toBe(false);
  });

  it('mismatched origin → blocked', () => {
    expect(isCsrfBlocked('https://evil.com', 'https://example.com')).toBe(true);
  });

  it('origin present but siteUrl unset → NOW blocked (was silently allowed before)', () => {
    expect(isCsrfBlocked('https://evil.com', undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Replay-protection map cap (app/api/webhooks/helius/route.ts fix)
// ---------------------------------------------------------------------------
describe('Replay-protection map cap enforcement', () => {
  const MAX = 10;
  const TTL = 24 * 60 * 60 * 1000;

  function markProcessed(map: Map<string, number>, sig: string): void {
    if (map.size >= MAX) {
      const now = Date.now();
      for (const [s, ts] of map) {
        if (now - ts > TTL) map.delete(s);
      }
      if (map.size >= MAX) {
        let oldestSig = '';
        let oldestTs = Infinity;
        for (const [s, ts] of map) {
          if (ts < oldestTs) { oldestTs = ts; oldestSig = s; }
        }
        if (oldestSig) map.delete(oldestSig);
      }
    }
    map.set(sig, Date.now());
  }

  it('map never exceeds cap even with all-recent entries', () => {
    const map = new Map<string, number>();
    for (let i = 0; i < MAX + 5; i++) markProcessed(map, `sig${i}`);
    expect(map.size).toBeLessThanOrEqual(MAX);
  });

  it('new signature is always recorded after eviction', () => {
    const map = new Map<string, number>();
    for (let i = 0; i < MAX; i++) map.set(`sig${i}`, Date.now());
    markProcessed(map, 'newSig');
    expect(map.has('newSig')).toBe(true);
    expect(map.size).toBeLessThanOrEqual(MAX);
  });
});

// ---------------------------------------------------------------------------
// 11. VISITOR_HASH_SALT required (app/api/page-views/route.ts fix)
// ---------------------------------------------------------------------------
describe('VISITOR_HASH_SALT required validation', () => {
  function getHashSalt(env: Record<string, string | undefined>): string {
    const salt = env['VISITOR_HASH_SALT'];
    if (!salt) throw new Error('VISITOR_HASH_SALT env var is required');
    return salt;
  }

  it('throws when VISITOR_HASH_SALT is missing instead of using hardcoded default', () => {
    expect(() => getHashSalt({})).toThrow('VISITOR_HASH_SALT env var is required');
  });

  it('returns configured salt', () => {
    expect(getHashSalt({ VISITOR_HASH_SALT: 'my-secure-salt' })).toBe('my-secure-salt');
  });
});
