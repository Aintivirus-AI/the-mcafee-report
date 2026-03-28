/**
 * Secrets Provider — abstracts private key retrieval.
 *
 * Three modes (configured via WALLET_SECRET_PROVIDER env var):
 *
 *   "aws"       – Fetches the key from AWS Secrets Manager at runtime.
 *                  Requires @aws-sdk/client-secrets-manager and the
 *                  AWS_SECRET_NAME / AWS_REGION env vars.
 *
 *   "encrypted" – Decrypts MASTER_WALLET_ENCRYPTED_KEY using
 *                  WALLET_ENCRYPTION_KEY (AES-256-GCM).
 *
 *   "env"       – Reads MASTER_WALLET_PRIVATE_KEY from the environment
 *                  (current behaviour). Logs a warning — only for local dev.
 */

import { createDecipheriv } from "crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProviderMode = "aws" | "encrypted" | "env";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROVIDER_MODE: ProviderMode =
  (process.env.WALLET_SECRET_PROVIDER as ProviderMode) || "env";

// ---------------------------------------------------------------------------
// In-memory cache so we don't hit Secrets Manager on every transaction.
// The cached value is cleared after CACHE_TTL_MS so key rotation takes effect.
// ---------------------------------------------------------------------------

let cachedKey: string | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isCacheValid(): boolean {
  return cachedKey !== null && Date.now() - cachedAt < CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// AWS Secrets Manager
// ---------------------------------------------------------------------------

async function fetchFromAWS(): Promise<string> {
  const secretName = process.env.AWS_SECRET_NAME;
  const region = process.env.AWS_REGION || "us-east-1";

  if (!secretName) {
    throw new Error(
      "AWS_SECRET_NAME env var is required when WALLET_SECRET_PROVIDER=aws"
    );
  }

  // Dynamic import so the SDK is only loaded when actually needed.
  // This avoids adding a hard dependency for dev/staging environments.
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    "@aws-sdk/client-secrets-manager"
  );

  const client = new SecretsManagerClient({ region });
  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error(`AWS secret "${secretName}" has no SecretString value`);
  }

  // The secret can be stored as plain base58 or as JSON { "privateKey": "..." }
  const raw = response.SecretString.trim();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.privateKey !== "string" || !parsed.privateKey) {
      throw new Error("Invalid secret format: expected { \"privateKey\": \"...\" }");
    }
    return parsed.privateKey;
  } catch (e) {
    if ((e as Error).message.startsWith("Invalid secret format")) throw e;
    // Not JSON — treat as raw base58 string
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Encrypted environment variable (AES-256-GCM)
// ---------------------------------------------------------------------------

/**
 * Decrypt an AES-256-GCM encrypted string.
 *
 * @param encrypted  - Format: `<hex-iv>:<hex-authTag>:<hex-ciphertext>`
 * @param encryptionKeyHex - 64-character hex string (32 bytes)
 * @returns The decrypted plaintext (UTF-8).
 */
export function decryptPrivateKey(
  encrypted: string,
  encryptionKeyHex: string
): string {
  if (!encryptionKeyHex || encryptionKeyHex.length !== 64) {
    throw new Error(
      "Encryption key must be a 64-character hex string (32 bytes)"
    );
  }

  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error(
      "Encrypted value must be in format <hex-iv>:<hex-authTag>:<hex-ciphertext>"
    );
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const key = Buffer.from(encryptionKeyHex, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf-8");
}

/**
 * Decrypt the master wallet key from environment variables.
 * Delegates to the generic decryptPrivateKey() with env-sourced values.
 */
function decryptFromEnv(): string {
  const encryptedKey = process.env.MASTER_WALLET_ENCRYPTED_KEY;
  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;

  if (!encryptedKey) {
    throw new Error(
      "MASTER_WALLET_ENCRYPTED_KEY env var is required when WALLET_SECRET_PROVIDER=encrypted"
    );
  }

  return decryptPrivateKey(encryptedKey, encryptionKey || "");
}

// ---------------------------------------------------------------------------
// Plain environment variable (dev only)
// ---------------------------------------------------------------------------

function readFromEnv(): string {
  const key = process.env.MASTER_WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error("MASTER_WALLET_PRIVATE_KEY environment variable not set");
  }

  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[SecretsProvider] WARNING: Using plain-text private key in production. " +
        'Set WALLET_SECRET_PROVIDER to "aws" or "encrypted" for production deployments.'
    );
  }

  return key;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the master wallet private key (base58-encoded) from the
 * configured secrets provider. Uses an in-memory cache with a 5-minute TTL.
 */
export async function getPrivateKey(): Promise<string> {
  if (isCacheValid()) {
    return cachedKey!;
  }

  let key: string;

  switch (PROVIDER_MODE) {
    case "aws":
      console.log("[SecretsProvider] Fetching private key from AWS Secrets Manager");
      key = await fetchFromAWS();
      break;

    case "encrypted":
      console.log("[SecretsProvider] Decrypting private key from encrypted env var");
      key = decryptFromEnv();
      break;

    case "env":
      key = readFromEnv();
      break;

    default:
      throw new Error(
        `Unknown WALLET_SECRET_PROVIDER: "${PROVIDER_MODE}". Must be "aws", "encrypted", or "env".`
      );
  }

  if (!key || key.trim().length === 0) {
    throw new Error("Secrets provider returned an empty private key");
  }

  cachedKey = key.trim();
  cachedAt = Date.now();

  return cachedKey;
}

/**
 * Synchronous getter — returns the cached key or resolves synchronously
 * for "env" and "encrypted" modes.
 *
 * For "aws" mode, `initializeKey()` MUST have been called first.
 * If the cache is empty in AWS mode, this throws with a helpful message.
 */
export function getPrivateKeySync(): string {
  if (isCacheValid()) {
    return cachedKey!;
  }

  // "env" and "encrypted" modes can resolve synchronously
  if (PROVIDER_MODE === "env") {
    const key = readFromEnv();
    cachedKey = key.trim();
    cachedAt = Date.now();
    return cachedKey;
  }

  if (PROVIDER_MODE === "encrypted") {
    console.log("[SecretsProvider] Decrypting private key from encrypted env var");
    const key = decryptFromEnv();
    cachedKey = key.trim();
    cachedAt = Date.now();
    return cachedKey;
  }

  // AWS mode requires async init
  throw new Error(
    "[SecretsProvider] Private key not initialized. " +
      'Call "await initializeKey()" at startup when using WALLET_SECRET_PROVIDER=aws.'
  );
}

/**
 * Pre-fetch the private key. Must be called once at app/worker startup
 * when using the "aws" provider. Safe to call for other modes too (no-op
 * if cache is already warm).
 */
export async function initializeKey(): Promise<void> {
  await getPrivateKey();
  console.log("[SecretsProvider] Key initialized and cached");
}

/**
 * Invalidate the cached key. Call this if you suspect key compromise
 * or after a rotation event.
 */
export function clearKeyCache(): void {
  cachedKey = null;
  cachedAt = 0;
}

/**
 * Utility: encrypt a base58 private key for use with the "encrypted" provider.
 * Run once via CLI to generate the values for MASTER_WALLET_ENCRYPTED_KEY.
 *
 *   npx tsx -e "import{encryptPrivateKey}from'./lib/secrets-provider';console.log(encryptPrivateKey('YOUR_BASE58_KEY','YOUR_64_HEX_KEY'))"
 */
export function encryptPrivateKey(
  base58Key: string,
  encryptionKeyHex: string
): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCipheriv, randomBytes } = require("crypto") as typeof import("crypto");

  if (encryptionKeyHex.length !== 64) {
    throw new Error("Encryption key must be a 64-character hex string (32 bytes)");
  }

  const key = Buffer.from(encryptionKeyHex, "hex");
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(base58Key, "utf-8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}
