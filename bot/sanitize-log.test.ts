/**
 * Tests for the sanitizeForLog pattern used in bot/index.ts.
 * The function escapes newlines and control characters in user-supplied strings
 * before they are written to logs, preventing log-injection attacks.
 */
import { describe, it, expect } from "vitest";

// Same implementation as sanitizeForLog in bot/index.ts
function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n\t\x00-\x1f\x7f]/g, (ch) =>
    `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`
  );
}

describe("sanitizeForLog", () => {
  it("passes through plain URLs unchanged", () => {
    const url = "https://example.com/article?id=42";
    expect(sanitizeForLog(url)).toBe(url);
  });

  it("escapes newline characters (log injection vector)", () => {
    const malicious = "https://example.com\nFAKE LOG: user=admin action=delete";
    const result = sanitizeForLog(malicious);
    expect(result).not.toContain("\n");
    expect(result).toContain("\\x0a");
  });

  it("escapes carriage return characters", () => {
    const malicious = "title\rFAKE";
    const result = sanitizeForLog(malicious);
    expect(result).not.toContain("\r");
    expect(result).toContain("\\x0d");
  });

  it("escapes tab characters", () => {
    expect(sanitizeForLog("col1\tcol2")).toContain("\\x09");
  });

  it("escapes null bytes", () => {
    expect(sanitizeForLog("abc\x00def")).toContain("\\x00");
  });

  it("escapes ANSI escape sequences (terminal injection)", () => {
    const ansi = "\x1b[31mERROR\x1b[0m";
    const result = sanitizeForLog(ansi);
    expect(result).not.toContain("\x1b");
    expect(result).toContain("\\x1b");
  });

  it("does not alter printable ASCII", () => {
    const clean = "Normal article title: BTC hits $100k";
    expect(sanitizeForLog(clean)).toBe(clean);
  });
});
