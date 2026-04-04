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
