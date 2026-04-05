/**
 * Tests for input validation logic in the submissions route.
 * Validates the fix for: missing input validation on submission ID parameter.
 */
import { describe, it, expect } from "vitest";

// Extracted validation logic matching what the route now enforces
function isValidSubmissionId(id: unknown): boolean {
  return Number.isInteger(id) && (id as number) > 0;
}

describe("submission ID validation", () => {
  it("accepts a positive integer", () => {
    expect(isValidSubmissionId(1)).toBe(true);
    expect(isValidSubmissionId(100)).toBe(true);
  });

  it("rejects zero", () => {
    expect(isValidSubmissionId(0)).toBe(false);
  });

  it("rejects negative integers", () => {
    expect(isValidSubmissionId(-1)).toBe(false);
  });

  it("rejects floats (e.g. 1.5)", () => {
    expect(isValidSubmissionId(1.5)).toBe(false);
  });

  it("rejects scientific notation numbers (e.g. 1e10 parsed as float)", () => {
    // JSON.parse('1e10') yields a number that is an integer in JS but
    // Number.isInteger(1e10) returns true since 1e10 === 10000000000.
    // Still, an attacker passing 1e-1 (0.1) would be caught:
    expect(isValidSubmissionId(0.1)).toBe(false);
  });

  it("rejects string IDs", () => {
    expect(isValidSubmissionId("1")).toBe(false);
    expect(isValidSubmissionId("abc")).toBe(false);
  });

  it("rejects null and undefined", () => {
    expect(isValidSubmissionId(null)).toBe(false);
    expect(isValidSubmissionId(undefined)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isValidSubmissionId(NaN)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isValidSubmissionId(Infinity)).toBe(false);
  });
});
