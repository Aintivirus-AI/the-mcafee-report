/**
 * Shared authentication utilities.
 *
 * - Timing-safe API key comparison (prevents character-by-character brute-force)
 * - Centralised auth check used by all API routes
 */

import { timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";

/**
 * Timing-safe string comparison.
 * JavaScript `===` short-circuits on the first non-matching character,
 * allowing attackers to brute-force secrets via timing side-channels.
 */
export function safeCompare(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  // Always run timingSafeEqual regardless of length to avoid timing side-channels
  // that would reveal the length of the secret. Pad both to the same length first,
  // then separately check length equality (non-short-circuit via &).
  const maxLen = Math.max(a.length, b.length, 1);
  try {
    const bufA = Buffer.alloc(maxLen);
    const bufB = Buffer.alloc(maxLen);
    bufA.write(a, "utf-8");
    bufB.write(b, "utf-8");
    // timingSafeEqual takes constant time regardless of content
    const contentsEqual = timingSafeEqual(bufA, bufB);
    // Length check must not short-circuit before the constant-time comparison
    return contentsEqual && a.length === b.length;
  } catch {
    return false;
  }
}

/**
 * Authenticate a request using the x-api-key header.
 * Reads API_SECRET_KEY from env at call time (supports key rotation without restart).
 * Only accepts the key via header — never query parameters (they leak in logs).
 */
export function isAuthenticated(request: NextRequest): boolean {
  const apiKey = request.headers.get("x-api-key");
  const expectedKey = process.env.API_SECRET_KEY;

  if (!apiKey || !expectedKey) return false;

  return safeCompare(apiKey, expectedKey);
}

/**
 * Validate that a string looks like a Solana base58 address (32-44 alphanumeric chars).
 */
export function isValidBase58Address(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

/**
 * Validate URL protocol — only allow http(s) to prevent javascript: XSS.
 */
export function isSafeUrlProtocol(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Clamp a numeric value between min and max.
 */
export function clampInt(value: number, min: number, max: number): number {
  if (isNaN(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}
