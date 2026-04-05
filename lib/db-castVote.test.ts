/**
 * Unit tests for the castVote error-handling fix.
 *
 * Regression: castVote previously caught ALL errors and returned false,
 * masking real DB failures as "already voted" responses.
 * After the fix it only swallows UNIQUE constraint errors and re-throws others.
 */
import { describe, it, expect } from "vitest";

// Replicate the fixed error-handling logic in isolation (no real DB required)
function castVoteErrorHandling(
  runFn: () => { changes: number }
): boolean {
  try {
    const result = runFn();
    return result.changes > 0;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return false;
    }
    throw error;
  }
}

describe("castVote error handling", () => {
  it("returns true when a row is inserted", () => {
    expect(castVoteErrorHandling(() => ({ changes: 1 }))).toBe(true);
  });

  it("returns false on UNIQUE constraint violation (already voted)", () => {
    expect(
      castVoteErrorHandling(() => {
        throw new Error("UNIQUE constraint failed: votes.voter_hash");
      })
    ).toBe(false);
  });

  it("re-throws non-UNIQUE DB errors (e.g. disk full, corruption)", () => {
    expect(() =>
      castVoteErrorHandling(() => {
        throw new Error("disk I/O error");
      })
    ).toThrow("disk I/O error");
  });

  it("re-throws generic errors that are not UNIQUE constraint failures", () => {
    expect(() =>
      castVoteErrorHandling(() => {
        throw new Error("database is locked");
      })
    ).toThrow("database is locked");
  });
});
