import { describe, it, expect } from "vitest";
import { decryptPrivateKey, encryptPrivateKey } from "./secrets-provider";

const TEST_KEY_HEX = "a".repeat(64); // 32-byte key as 64-char hex

describe("decryptPrivateKey", () => {
  it("round-trips encrypt/decrypt correctly", () => {
    const original = "5xOriginalBase58PrivateKey123456789";
    const encrypted = encryptPrivateKey(original, TEST_KEY_HEX);
    const decrypted = decryptPrivateKey(encrypted, TEST_KEY_HEX);
    expect(decrypted).toBe(original);
  });

  it("throws on wrong encryption key", () => {
    const encrypted = encryptPrivateKey("somekey", TEST_KEY_HEX);
    const wrongKey = "b".repeat(64);
    expect(() => decryptPrivateKey(encrypted, wrongKey)).toThrow();
  });

  it("throws on key that is not 64 hex chars", () => {
    const encrypted = encryptPrivateKey("somekey", TEST_KEY_HEX);
    expect(() => decryptPrivateKey(encrypted, "short-key")).toThrow(
      "Encryption key must be a 64-character hex string"
    );
  });

  it("throws on malformed encrypted string", () => {
    expect(() => decryptPrivateKey("not:valid", TEST_KEY_HEX)).toThrow(
      "Encrypted value must be in format"
    );
  });
});
