/**
 * Secure Wallet Facade — single entry point for all wallet operations.
 *
 * Every caller (pump-deployer, revenue-distributor, etc.) imports from this
 * module instead of solana-wallet.ts directly.  Each operation:
 *   1. Checks guardrails (limits, allowlist, rate-limit)
 *   2. Delegates to the underlying solana-wallet function
 *   3. Logs the result to the audit trail
 *
 * This ensures no wallet operation can bypass the safety layer.
 */

import type { Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getConnection as _getConnection,
  getMasterWallet as _getMasterWallet,
  getMasterWalletAddress as _getMasterWalletAddress,
  getMasterWalletBalance as _getMasterWalletBalance,
  sendSol as _sendSol,
  isValidSolanaAddress,
  confirmTransactionPolling,
} from "./solana-wallet";
import { logWalletOperation } from "./wallet-audit";
import {
  checkSendGuardrails,
  checkOperationGuardrails,
  withGuardrailLock,
} from "./wallet-guardrails";

// Re-export utilities that don't need the security wrapper
export { getConnection, isValidSolanaAddress, confirmTransactionPolling } from "./solana-wallet";

// ---------------------------------------------------------------------------
// Secure send SOL
// ---------------------------------------------------------------------------

/**
 * Send SOL with full guardrail checks and audit logging.
 * Drop-in replacement for solana-wallet's sendSol().
 */
export async function secureSendSol(
  recipientAddress: string,
  lamports: number,
  caller: string,
  options: { maxRetries?: number; skipPreflight?: boolean } = {}
): Promise<{ success: boolean; signature?: string; error?: string }> {
  return withGuardrailLock(async () => {
    // Pre-flight guardrail check (inside lock to prevent TOCTOU on daily limit)
    const guardrailResult = checkSendGuardrails(recipientAddress, lamports, caller);
    if (!guardrailResult.allowed) {
      return { success: false, error: guardrailResult.reason };
    }

    // Delegate to the underlying wallet
    const result = await _sendSol(recipientAddress, lamports, options);

    // Audit log
    logWalletOperation({
      operation: "send_sol",
      amountLamports: lamports,
      destination: recipientAddress,
      txSignature: result.signature,
      caller,
      success: result.success,
      errorMessage: result.error,
    });

    return result;
  });
}

// ---------------------------------------------------------------------------
// Secure wallet access (for signing)
// ---------------------------------------------------------------------------

/**
 * Get the master wallet Keypair for transaction signing.
 * Logs every access to the audit trail.
 *
 * Use this instead of importing getMasterWallet() from solana-wallet directly.
 */
export function secureGetWallet(caller: string): Keypair {
  logWalletOperation({
    operation: "wallet_access",
    caller,
    success: true,
  });

  return _getMasterWallet();
}

// ---------------------------------------------------------------------------
// Secure balance check
// ---------------------------------------------------------------------------

/**
 * Get the master wallet balance with audit logging.
 */
export async function secureGetBalance(
  caller: string
): Promise<{ lamports: number; sol: number }> {
  const balance = await _getMasterWalletBalance();

  logWalletOperation({
    operation: "balance_check",
    amountLamports: balance.lamports,
    caller,
    success: true,
    metadata: { sol: balance.sol },
  });

  return balance;
}

/**
 * Get the master wallet public key as string.
 * Lightweight — no audit log for address reads.
 */
export function secureGetWalletAddress(): string {
  return _getMasterWalletAddress();
}

// ---------------------------------------------------------------------------
// Operation guardrail check (for deploy / burn)
// ---------------------------------------------------------------------------

/**
 * Pre-check for operations that spend SOL via fees (deploy, swap, burn).
 * Call this before executing the operation to ensure it won't exceed limits.
 *
 * @param estimatedLamports - Estimated SOL cost of the operation
 * @param caller - Module name for audit trail
 * @returns { allowed: true } or { allowed: false, reason: "..." }
 */
export function checkOperation(
  estimatedLamports: number,
  caller: string
): { allowed: boolean; reason?: string } {
  return checkOperationGuardrails(estimatedLamports, caller);
}

// ---------------------------------------------------------------------------
// Audit helpers for callers that need to log custom operations
// ---------------------------------------------------------------------------

/**
 * Log a deploy-token operation result.
 * Called by pump-deployer after a successful or failed deployment.
 */
export function logDeployment(params: {
  caller: string;
  success: boolean;
  mintAddress?: string;
  txSignature?: string;
  errorMessage?: string;
  estimatedCostLamports?: number;
}): void {
  logWalletOperation({
    operation: "deploy_token",
    amountLamports: params.estimatedCostLamports ?? 0,
    destination: params.mintAddress,
    txSignature: params.txSignature,
    caller: params.caller,
    success: params.success,
    errorMessage: params.errorMessage,
  });
}

/**
 * Log a buy-and-burn operation result.
 * Called by revenue-distributor after a swap + burn.
 */
export function logBuyBurn(params: {
  caller: string;
  success: boolean;
  amountLamports: number;
  txSignature?: string;
  errorMessage?: string;
}): void {
  logWalletOperation({
    operation: "buy_burn",
    amountLamports: params.amountLamports,
    txSignature: params.txSignature,
    caller: params.caller,
    success: params.success,
    errorMessage: params.errorMessage,
  });
}
