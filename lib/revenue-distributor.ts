import { 
  LAMPORTS_PER_SOL, 
} from "@solana/web3.js";
import {
  isValidSolanaAddress,
} from "./solana-wallet";
import {
  secureSendSol,
} from "./secure-wallet";
import {
  createRevenueEvent,
  getTokenById,
  getSubmissionById,
  updateRevenueEventStatus,
  getPendingRevenueEvents,
  getRevenueStats,
  recordEarning,
} from "./db";
import type { RevenueEvent, Token } from "./types";

// Configuration
const MIN_DISTRIBUTION_AMOUNT = 0.001 * LAMPORTS_PER_SOL; // Minimum 0.001 SOL to distribute

/**
 * Revenue distribution result
 */
export interface DistributionResult {
  success: boolean;
  submitterTxSignature?: string;
  /** Currently unused — buy-and-burn is disabled. Kept for API compatibility. */
  burnTxSignature?: string;
  error?: string;
}

/**
 * Record and distribute revenue from a token
 * @param tokenId - The token ID in our database
 * @param amountLamports - Total amount received in lamports
 */
export async function recordAndDistributeRevenue(
  tokenId: number,
  amountLamports: number
): Promise<DistributionResult> {
  console.log(`[Revenue] Recording revenue for token #${tokenId}: ${amountLamports / LAMPORTS_PER_SOL} SOL`);
  
  // Get token details
  const token = getTokenById(tokenId);
  if (!token) {
    return { success: false, error: "Token not found" };
  }
  
  if (!isValidSolanaAddress(token.deployer_sol_address)) {
    return { success: false, error: "Invalid submitter address" };
  }
  
  // Check minimum amount
  if (amountLamports < MIN_DISTRIBUTION_AMOUNT) {
    return { success: false, error: `Amount too small: ${amountLamports / LAMPORTS_PER_SOL} SOL` };
  }
  
  // Create revenue event record
  const revenueEvent = createRevenueEvent(tokenId, amountLamports);
  console.log(`[Revenue] Created revenue event #${revenueEvent.id}`);
  
  // Distribute the revenue
  return await distributeRevenue(revenueEvent, token);
}

/**
 * Distribute revenue for a recorded event
 */
async function distributeRevenue(
  event: RevenueEvent,
  token: Token
): Promise<DistributionResult> {
  const submitterShare = event.submitter_share_lamports;
  const creatorShare = event.burn_share_lamports;
  
  console.log(`[Revenue] Distributing event #${event.id}:`);
  console.log(`  - Submitter: ${submitterShare / LAMPORTS_PER_SOL} SOL to ${token.deployer_sol_address}`);
  console.log(`  - Creator wallet (retained): ${creatorShare / LAMPORTS_PER_SOL} SOL`);
  
  let submitterTxSignature: string | undefined;
  
  // Step 1: Send 50% to submitter (via secure wallet with guardrails)
  try {
    const submitterResult = await secureSendSol(
      token.deployer_sol_address,
      submitterShare,
      "revenue-distributor"
    );
    
    if (submitterResult.success) {
      submitterTxSignature = submitterResult.signature;
      updateRevenueEventStatus(event.id, "submitter_paid", submitterTxSignature);
      console.log(`[Revenue] Submitter paid: ${submitterTxSignature}`);

      if (token.submission_id) {
        const submission = getSubmissionById(token.submission_id);
        if (submission) {
          recordEarning({
            telegramUserId: submission.telegram_user_id,
            telegramUsername: submission.telegram_username ?? null,
            solAddress: submission.sol_address,
            amountLamports: submitterShare,
            source: "revenue_event",
            sourceId: event.id,
            tokenTicker: token.ticker,
            txSignature: submitterTxSignature,
          });
        }
      }
    } else {
      console.error(`[Revenue] Failed to pay submitter: ${submitterResult.error}`);
      updateRevenueEventStatus(event.id, "failed");
      return { success: false, error: `Failed to pay submitter: ${submitterResult.error}` };
    }
  } catch (error) {
    console.error("[Revenue] Error paying submitter:", error);
    updateRevenueEventStatus(event.id, "failed");
    return { success: false, error: "Failed to pay submitter" };
  }
  
  // Step 2: Keep creator share in master wallet (buy-and-burn disabled)
  // The creator share SOL is already in the master wallet — no transfer needed.
  console.log(`[Revenue] Creator share (${creatorShare / LAMPORTS_PER_SOL} SOL) retained in creator wallet`);
  updateRevenueEventStatus(event.id, "completed");
  
  return {
    success: true,
    submitterTxSignature,
  };
}

// ---------------------------------------------------------------------------
// Buy-and-burn functions (Jupiter swap + SPL burn) have been removed from the
// hot path.  The creator's 50% share is now retained in the master wallet.
// To re-enable buy-and-burn in the future, restore the buyAndBurnNews(),
// getJupiterQuote(), executeJupiterSwap(), and burnTokens() functions from
// git history and wire them back into distributeRevenue() Step 2.
// ---------------------------------------------------------------------------

/**
 * Process all pending revenue events.
 * Call this periodically (e.g., every 5 minutes).
 */
export async function processPendingRevenue(): Promise<{
  processed: number;
  failed: number;
  results: Array<{ eventId: number; success: boolean; error?: string }>;
}> {
  const pending = getPendingRevenueEvents(10);
  console.log(`[Revenue] Processing ${pending.length} pending revenue events`);
  
  const results: Array<{ eventId: number; success: boolean; error?: string }> = [];
  let processed = 0;
  let failed = 0;
  
  for (const event of pending) {
    const token = getTokenById(event.token_id);
    if (!token) {
      updateRevenueEventStatus(event.id, "failed");
      results.push({ eventId: event.id, success: false, error: "Token not found" });
      failed++;
      continue;
    }
    
    const result = await distributeRevenue(event, token);
    results.push({
      eventId: event.id,
      success: result.success,
      error: result.error,
    });
    
    if (result.success) {
      processed++;
    } else {
      failed++;
    }
    
    // Small delay between distributions
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log(`[Revenue] Processed: ${processed}, Failed: ${failed}`);
  return { processed, failed, results };
}

/**
 * Get revenue statistics
 */
export function getRevenueStatistics(): {
  totalLamports: number;
  totalSol: number;
  distributedLamports: number;
  distributedSol: number;
  burnedLamports: number;
  burnedSol: number;
} {
  const stats = getRevenueStats();
  
  return {
    totalLamports: stats.total,
    totalSol: stats.total / LAMPORTS_PER_SOL,
    distributedLamports: stats.distributed,
    distributedSol: stats.distributed / LAMPORTS_PER_SOL,
    burnedLamports: stats.burned,
    burnedSol: stats.burned / LAMPORTS_PER_SOL,
  };
}

/**
 * Estimate distribution for an amount.
 * Uses the same share percentage as db.createRevenueEvent (env-configurable).
 *
 * - submitterShare: sent to the headline submitter's wallet
 * - creatorShare: retained in the master/creator wallet (buy-and-burn disabled)
 */
export function estimateDistribution(amountLamports: number): {
  submitterShare: number;
  creatorShare: number;
  submitterShareSol: number;
  creatorShareSol: number;
} {
  const rawPercent = parseFloat(process.env.REVENUE_SUBMITTER_SHARE || "0.5");
  const sharePercent = isNaN(rawPercent) ? 0.5 : Math.max(0, Math.min(1, rawPercent));
  const submitterShare = Math.floor(amountLamports * sharePercent);
  const creatorShare = amountLamports - submitterShare;
  
  return {
    submitterShare,
    creatorShare,
    submitterShareSol: submitterShare / LAMPORTS_PER_SOL,
    creatorShareSol: creatorShare / LAMPORTS_PER_SOL,
  };
}
