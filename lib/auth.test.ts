import { describe, it, expect } from "vitest";
import { safeCompare } from "./auth";

describe("safeCompare", () => {
  it("returns true for identical strings", () => {
    expect(safeCompare("secret-key-abc123", "secret-key-abc123")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(safeCompare("secret-key-abc123", "secret-key-abc124")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    // Non-timing-safe === would also short-circuit here, but safeCompare must
    // guard against timing leakage for equal-length near-misses
    expect(safeCompare("short", "much-longer-string")).toBe(false);
  });

  it("returns false for empty vs non-empty", () => {
    expect(safeCompare("", "secret")).toBe(false);
  });

  it("returns false for non-string inputs", () => {
    // @ts-expect-error testing runtime guard
    expect(safeCompare(null, "secret")).toBe(false);
    // @ts-expect-error testing runtime guard
    expect(safeCompare("secret", undefined)).toBe(false);
  });

  it("returns true for empty vs empty", () => {
    expect(safeCompare("", "")).toBe(true);
  });
});
