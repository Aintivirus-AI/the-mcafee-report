/**
 * URL validation (SSRF protection), safe fetch with timeout/size limits,
 * and content sanitization for AI prompt injection prevention.
 */

// ============= SSRF PROTECTION =============

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  // Cloud metadata endpoints (SSRF targets)
  "metadata.google.internal",
  "metadata.google",
  "metadata",
  "169.254.169.254",          // AWS EC2 / Azure IMDS / GCP metadata
  "100.100.100.200",          // Alibaba Cloud metadata
  "metadata.tencentyun.com",  // Tencent Cloud metadata
  "169.254.170.2",            // AWS ECS task metadata
]);

const BLOCKED_IP_PATTERNS: RegExp[] = [
  /^127\./,                                        // Loopback
  /^10\./,                                         // Private Class A
  /^172\.(1[6-9]|2\d|3[01])\./,                   // Private Class B
  /^192\.168\./,                                   // Private Class C
  /^169\.254\./,                                   // Link-local (AWS metadata endpoint)
  /^0\./,                                          // Current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,     // Shared address space (CGN)
  /^198\.1[89]\./,                                 // Benchmark testing
  /^192\.0\.0\./,                                  // IETF Protocol Assignments
  /^192\.0\.2\./,                                  // TEST-NET-1
  /^198\.51\.100\./,                               // TEST-NET-2
  /^203\.0\.113\./,                                // TEST-NET-3
  /^224\./,                                        // Multicast
  /^240\./,                                        // Reserved
  /^255\./,                                        // Broadcast
];

/**
 * Normalise an IP string to catch encoding bypasses.
 * Converts octal (0177.0.0.1), hex (0x7f000001), and decimal (2130706433)
 * representations into dotted-decimal so BLOCKED_IP_PATTERNS can catch them.
 */
function normaliseIp(hostname: string): string | null {
  // Pure decimal integer (e.g. 2130706433)
  if (/^\d+$/.test(hostname)) {
    const num = parseInt(hostname, 10);
    if (num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 0xff,
        (num >>> 16) & 0xff,
        (num >>> 8) & 0xff,
        num & 0xff,
      ].join(".");
    }
  }

  // Dotted notation with possible octal/hex parts (e.g. 0177.0.0.01 or 0x7f.0.0.1)
  const parts = hostname.split(".");
  if (parts.length === 4) {
    const octets: number[] = [];
    for (const part of parts) {
      let n: number;
      if (part.startsWith("0x") || part.startsWith("0X")) {
        n = parseInt(part, 16);
      } else if (part.startsWith("0") && part.length > 1) {
        n = parseInt(part, 8);
      } else {
        n = parseInt(part, 10);
      }
      if (isNaN(n) || n < 0 || n > 255) return null;
      octets.push(n);
    }
    return octets.join(".");
  }

  return null;
}

/**
 * Check if an IPv6 address is private/internal.
 * Covers loopback, IPv4-mapped, IPv4-compatible, link-local, and unique-local.
 */
function isPrivateIPv6(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  // Loopback
  if (clean === "::1" || clean === "0:0:0:0:0:0:0:1") return true;

  // Unspecified address
  if (clean === "::" || clean === "0:0:0:0:0:0:0:0") return true;

  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  const v4MappedDotted = clean.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedDotted) {
    const ipv4 = v4MappedDotted[1];
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(ipv4)) return true;
    }
    return BLOCKED_HOSTNAMES.has(ipv4);
  }

  // IPv4-mapped IPv6 in hex form (::ffff:7f00:0001)
  const v4MappedHex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex) {
    const high = parseInt(v4MappedHex[1], 16);
    const low = parseInt(v4MappedHex[2], 16);
    const ipv4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(ipv4)) return true;
    }
    return BLOCKED_HOSTNAMES.has(ipv4);
  }

  // IPv4-compatible IPv6 (deprecated but still possible: ::127.0.0.1)
  const v4Compat = clean.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Compat) {
    const ipv4 = v4Compat[1];
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(ipv4)) return true;
    }
    return BLOCKED_HOSTNAMES.has(ipv4);
  }

  // Link-local (fe80::/10)
  if (clean.startsWith("fe8") || clean.startsWith("fe9") ||
      clean.startsWith("fea") || clean.startsWith("feb")) return true;

  // Unique local (fc00::/7)
  if (clean.startsWith("fc") || clean.startsWith("fd")) return true;

  return false;
}

/**
 * Check if a URL is safe to fetch (not pointing to internal/private resources).
 */
export function isUrlSafe(urlString: string): { safe: boolean; reason?: string } {
  try {
    const url = new URL(urlString);

    // Only allow http and https
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { safe: false, reason: "Only HTTP and HTTPS URLs are allowed" };
    }

    const hostname = url.hostname.toLowerCase();

    // Block known internal hostnames
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return { safe: false, reason: "URL points to a blocked internal host" };
    }

    // Block hostnames that end with known internal TLDs
    const internalTLDs = [".local", ".internal", ".corp", ".lan", ".home", ".localdomain", ".localhost", ".intranet"];
    if (internalTLDs.some(tld => hostname.endsWith(tld))) {
      return { safe: false, reason: "URL points to an internal host" };
    }

    // Check IPv6 private ranges
    if (hostname.startsWith("[") || hostname.includes(":")) {
      if (isPrivateIPv6(hostname)) {
        return { safe: false, reason: "URL points to a private IPv6 address" };
      }
    }

    // Block if hostname is an IP address in private range (standard dotted)
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return { safe: false, reason: "URL points to a private/reserved IP range" };
      }
    }

    // Normalise IP to catch octal/hex/decimal encoding bypasses
    const normalised = normaliseIp(hostname);
    if (normalised && normalised !== hostname) {
      for (const pattern of BLOCKED_IP_PATTERNS) {
        if (pattern.test(normalised)) {
          return { safe: false, reason: "URL points to a private/reserved IP range (encoded)" };
        }
      }
      if (BLOCKED_HOSTNAMES.has(normalised)) {
        return { safe: false, reason: "URL points to a blocked internal host (encoded)" };
      }
    }

    // Block non-standard ports (prevents probing internal services)
    if (url.port && url.port !== "80" && url.port !== "443") {
      return { safe: false, reason: "Non-standard ports are not allowed" };
    }

    return { safe: true };
  } catch {
    return { safe: false, reason: "Invalid URL format" };
  }
}

// ============= SAFE FETCH WITH TIMEOUT + SIZE LIMIT =============

const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

export interface SafeFetchOptions extends RequestInit {
  /** Timeout in milliseconds (default: 10s) */
  timeoutMs?: number;
  /** Maximum response body size in bytes (default: 2 MB) */
  maxBytes?: number;
  /** Skip the SSRF check (for trusted URLs like OpenAI CDN) */
  skipSsrfCheck?: boolean;
}

/**
 * Fetch a URL with SSRF protection, timeout, size limits, and redirect validation.
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {}
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES,
    skipSsrfCheck = false,
    ...fetchOptions
  } = options;

  // SSRF check
  if (!skipSsrfCheck) {
    const validation = isUrlSafe(url);
    if (!validation.safe) {
      throw new Error(`Blocked URL: ${validation.reason}`);
    }
  }

  // Abort controller for timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Disable automatic redirect following so we can validate each target
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      redirect: "manual",
    });

    // If redirect, validate the new URL before following
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("Redirect with no Location header");
      }

      // Resolve relative URLs
      const redirectUrl = new URL(location, url).toString();

      if (!skipSsrfCheck) {
        const redirectValidation = isUrlSafe(redirectUrl);
        if (!redirectValidation.safe) {
          throw new Error(`Blocked redirect target: ${redirectValidation.reason}`);
        }
      }

      // Follow the redirect (only one level deep to prevent loops)
      clearTimeout(timeout);
      const redirectTimeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const redirectResponse = await fetch(redirectUrl, {
          ...fetchOptions,
          signal: controller.signal,
          redirect: "follow", // allow subsequent redirects from validated target
        });

        // Check Content-Length if available
        const contentLength = redirectResponse.headers.get("content-length");
        if (contentLength) {
          const clLen = parseInt(contentLength, 10);
          if (!Number.isFinite(clLen) || clLen > maxBytes) {
            throw new Error(
              `Response too large: ${contentLength} bytes (max ${maxBytes})`
            );
          }
        }

        return redirectResponse;
      } finally {
        clearTimeout(redirectTimeout);
      }
    }

    // Check Content-Length if available
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const clLen = parseInt(contentLength, 10);
      if (!Number.isFinite(clLen) || clLen > maxBytes) {
        throw new Error(
          `Response too large: ${contentLength} bytes (max ${maxBytes})`
        );
      }
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch URL and return text with all safety checks.
 * Uses streaming to enforce size limit (prevents OOM from large responses).
 */
export async function safeFetchText(
  url: string,
  options: SafeFetchOptions = {}
): Promise<string> {
  const { maxBytes = MAX_RESPONSE_BYTES, ...rest } = options;

  const response = await safeFetch(url, { ...rest, maxBytes });

  // Stream the body with size enforcement to prevent OOM
  const reader = response.body?.getReader();
  if (!reader) {
    return await response.text();
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        // Truncate at limit — don't read any more
        const excess = totalBytes - maxBytes;
        chunks.push(value.slice(0, value.byteLength - excess));
        break;
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  return chunks.map(chunk => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
}

/**
 * Fetch URL and return JSON with all safety checks.
 */
export async function safeFetchJson<T = unknown>(
  url: string,
  options: SafeFetchOptions = {}
): Promise<T> {
  const response = await safeFetch(url, options);
  return (await response.json()) as T;
}

// ============= CONTENT SANITIZATION FOR AI PROMPTS =============

/**
 * Sanitize user-supplied content before inserting into AI prompts.
 * Strips common prompt-injection patterns and truncates to a safe length.
 *
 * NOTE: Denylist-based approaches are fundamentally incomplete. This is a
 * defense-in-depth layer — always combine with system/user message separation,
 * temperature settings, and output validation.
 */
export function sanitizeForPrompt(
  text: string,
  maxLength: number = 500
): string {
  if (!text) return "";

  return (
    text
      // Remove potential instruction overrides (case-insensitive, Unicode-aware)
      .replace(
        /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
        "[redacted]"
      )
      .replace(
        /disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?|directives?)/gi,
        "[redacted]"
      )
      .replace(
        /forget\s+(all\s+)?(previous|above|prior|your)\s+(instructions?|prompts?|rules?|context)/gi,
        "[redacted]"
      )
      .replace(/you\s+are\s+now\s+/gi, "[redacted] ")
      .replace(/new\s+instructions?\s*:/gi, "[redacted]:")
      .replace(/override\s+(previous\s+)?instructions?/gi, "[redacted]")
      .replace(/system\s*:/gi, "")
      .replace(/\bassistant\s*:/gi, "")
      .replace(/\bhuman\s*:/gi, "")
      // Defang JSON injections aimed at forcing specific AI output
      .replace(/\bJSON\s*:\s*\{/gi, "data: {")
      .replace(/respond\s+with\s*:\s*\{/gi, "")
      // Remove markdown code blocks that might confuse the model
      .replace(/```[\s\S]*?```/g, "[code block removed]")
      // Remove base64-encoded content that could hide injections
      .replace(/data:[a-zA-Z0-9/+]+;base64,[A-Za-z0-9+/=]{100,}/g, "[base64 removed]")
      // Collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
      // Truncate
      .substring(0, maxLength)
  );
}
