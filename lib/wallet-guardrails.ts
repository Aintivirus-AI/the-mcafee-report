/**
 * Wallet Guardrails — hard limits on outbound wallet operations.
 *
 * Even if the private key is compromised and an attacker gains code-execution,
 * these limits bound the maximum damage per transaction and per day.
 *
 * Configuration via environment variables (with safe defaults):
 *   MAX_TX_SOL          – Max SOL per single send (default: 1)
 *   MAX_DAILY_SOL       – Rolling 24h outflow cap (default: 10)
 *   ALLOWED_DESTINATIONS – Comma-separated allowlist of addresses (optional)
 */

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getDailyOutflowLamports, logWalletOperation } from "./wallet-audit";
import { isValidSolanaAddress } from "./solana-wallet";

// ---------------------------------------------------------------------------
// Configuration (read from env at call time to support hot-reload)
// ---------------------------------------------------------------------------

function getMaxTxLamports(): number {
  const sol = parseFloat(process.env.MAX_TX_SOL || "1");
  const clamped = isNaN(sol) || sol < 0 ? 1 : Math.min(sol, 100); // Clamp to [0, 100] SOL
  return Math.floor(clamped * LAMPORTS_PER_SOL);
}

function getMaxDailyLamports(): number {
  const sol = parseFloat(process.env.MAX_DAILY_SOL || "10");
  const clamped = isNaN(sol) || sol < 0 ? 10 : Math.min(sol, 1000); // Clamp to [0, 1000] SOL
  return Math.floor(clamped * LAMPORTS_PER_SOL);
}

function getAllowedDestinations(): Set<string> | null {
  const raw = process.env.ALLOWED_DESTINATIONS;
  if (!raw || raw.trim().length === 0) return null; // no restriction
  const addrs = raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  return new Set(addrs);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuardrailCheckResult {
  allowed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Simple in-process lock to serialise guardrail checks + wallet operations.
// Prevents the TOCTOU race where two concurrent calls both pass the daily
// limit check before either records its outflow.
let guardrailLock: Promise<void> = Promise.resolve();

export function withGuardrailLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = guardrailLock;
  let resolve: () => void;
  guardrailLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

/**
 * Validate a proposed outbound SOL transfer against all guardrails.
 * Returns { allowed: true } or { allowed: false, reason: "..." }.
 *
 * If blocked, an audit log entry with operation "guardrail_block" is written.
 *
 * NOTE: This should be called INSIDE withGuardrailLock() to prevent TOCTOU
 * races on the daily spending limit.
 */
export function checkSendGuardrails(
  recipientAddress: string,
  lamports: number,
  caller: string
): GuardrailCheckResult {
  // 1. Basic address validation (fast-fail before expensive checks)
  if (!isValidSolanaAddress(recipientAddress)) {
    const reason = `Invalid Solana address: ${recipientAddress}`;
    logGuardrailBlock(caller, reason, recipientAddress, lamports);
    return { allowed: false, reason };
  }

  // 2. Amount sanity check
  if (!Number.isFinite(lamports) || lamports <= 0) {
    const reason = `Invalid amount: ${lamports}`;
    logGuardrailBlock(caller, reason, recipientAddress, lamports);
    return { allowed: false, reason };
  }

  // 3. Per-transaction limit
  const maxTx = getMaxTxLamports();
  if (lamports > maxTx) {
    const reason = `Per-transaction limit exceeded: ${lamports / LAMPORTS_PER_SOL} SOL > ${maxTx / LAMPORTS_PER_SOL} SOL max`;
    logGuardrailBlock(caller, reason, recipientAddress, lamports);
    return { allowed: false, reason };
  }

  // 4. Daily spending limit
  const dailyOutflow = getDailyOutflowLamports();
  const maxDaily = getMaxDailyLamports();
  if (!Number.isSafeInteger(dailyOutflow + lamports)) {
    throw new Error("Amount overflow");
  }
  if (dailyOutflow + lamports > maxDaily) {
    const reason =
      `Daily spending limit would be exceeded: ` +
      `${(dailyOutflow + lamports) / LAMPORTS_PER_SOL} SOL > ${maxDaily / LAMPORTS_PER_SOL} SOL max ` +
      `(already spent ${dailyOutflow / LAMPORTS_PER_SOL} SOL in last 24h)`;
    logGuardrailBlock(caller, reason, recipientAddress, lamports);
    return { allowed: false, reason };
  }

  // 5. Destination allowlist (if configured)
  const allowlist = getAllowedDestinations();
  if (allowlist !== null && !allowlist.has(recipientAddress)) {
    const reason = `Destination ${recipientAddress} is not in the allowed destinations list`;
    logGuardrailBlock(caller, reason, recipientAddress, lamports);
    return { allowed: false, reason };
  }

  return { allowed: true };
}

/**
 * Lightweight guardrail check for non-send operations (deploy, burn)
 * that still consume SOL via fees. Only checks daily cap.
 */
export function checkOperationGuardrails(
  estimatedLamports: number,
  caller: string
): GuardrailCheckResult {
  // Daily spending limit
  const dailyOutflow = getDailyOutflowLamports();
  const maxDaily = getMaxDailyLamports();
  if (dailyOutflow + estimatedLamports > maxDaily) {
    const reason =
      `Daily spending limit would be exceeded for operation: ` +
      `${(dailyOutflow + estimatedLamports) / LAMPORTS_PER_SOL} SOL > ${maxDaily / LAMPORTS_PER_SOL} SOL max`;
    logGuardrailBlock(caller, reason, undefined, estimatedLamports);
    return { allowed: false, reason };
  }

  return { allowed: true };
}

/**
 * Return current guardrail status (useful for admin dashboards).
 */
export function getGuardrailStatus(): {
  maxTxSol: number;
  maxDailySol: number;
  dailyOutflowSol: number;
  dailyRemainingLamports: number;
  hasAllowlist: boolean;
} {
  const maxDaily = getMaxDailyLamports();
  const dailyOutflow = getDailyOutflowLamports();

  return {
    maxTxSol: getMaxTxLamports() / LAMPORTS_PER_SOL,
    maxDailySol: maxDaily / LAMPORTS_PER_SOL,
    dailyOutflowSol: dailyOutflow / LAMPORTS_PER_SOL,
    dailyRemainingLamports: Math.max(0, maxDaily - dailyOutflow),
    hasAllowlist: getAllowedDestinations() !== null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logGuardrailBlock(
  caller: string,
  reason: string,
  destination?: string,
  lamports?: number
): void {
  console.warn(`[Guardrails] BLOCKED (${caller}): ${reason}`);
  logWalletOperation({
    operation: "guardrail_block",
    caller,
    success: false,
    errorMessage: reason,
    destination,
    amountLamports: lamports,
  });
}
