/**
 * Claim Distributor — fair pro-rata distribution of bulk pump.fun claims.
 *
 * When pump.fun's "Claim" sends a single bulk SOL transfer to the master
 * wallet (with no per-token mint data), this module distributes the SOL
 * fairly across all active tokens based on their relative trading activity.
 *
 * Strategy: For each token we query Helius for the number of SWAP
 * transactions on its bonding curve address. Each swap generates a creator
 * fee, so the trade count (weighted by SOL moved) is the most direct proxy
 * for fee attribution.  We fall back to pump.fun's `usd_market_cap` if
 * Helius data is unavailable, since higher-cap tokens typically generated
 * more trading volume / fees.
 *
 * Flow:
 * 1. Fetch bonding curve address + market data for every active token
 * 2. Query Helius for SOL volume per bonding curve (actual trade data)
 * 3. Compute each token's activity delta since the last claim snapshot
 * 4. Split the bulk SOL proportionally (activity-weighted pro-rata)
 * 5. Apply the existing submitter/creator share split (default 50/50)
 * 6. Send each submitter's share via secureSendSol
 * 7. Record everything in claim_batches + claim_allocations for audit
 */

import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { isValidSolanaAddress } from "./solana-wallet";
import { secureSendSol } from "./secure-wallet";
import {
  getActiveTokensForClaim,
  getClaimBatchByTxSignature,
  createClaimBatch,
  updateClaimBatchStatus,
  createClaimAllocation,
  updateClaimAllocationStatus,
  getClaimAllocationsByBatch,
  getLastVolumeSnapshot,
  saveVolumeSnapshot,
  getTokenById,
  getSubmissionById,
  recordEarning,
} from "./db";
import type { Token } from "./types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimum total claim to process (avoid processing dust). */
const MIN_CLAIM_LAMPORTS = 10_000; // 0.00001 SOL

/** Minimum per-token distribution (skip if below this). */
const MIN_DISTRIBUTION_LAMPORTS = Math.floor(0.001 * LAMPORTS_PER_SOL);

/** Submitter share percentage (mirrors revenue-distributor logic). */
function getSubmitterSharePercent(): number {
  const raw = parseFloat(process.env.REVENUE_SUBMITTER_SHARE || "0.5");
  return isNaN(raw) ? 0.5 : Math.max(0, Math.min(1, raw));
}

/** Pump.fun API URLs — try v3 first, fall back to v1. */
const PUMP_API_V3 = "https://frontend-api-v3.pump.fun/coins";
const PUMP_API_V1 = "https://frontend-api.pump.fun/coins";

/** Maximum Helius pages to fetch per bonding curve (prevent runaway). */
const MAX_HELIUS_PAGES = 10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenVolume {
  tokenId: number;
  mintAddress: string;
  currentVolume: number;      // Cumulative activity metric (SOL volume via Helius, or market cap fallback)
  previousVolume: number;     // Last snapshot (0 if first claim)
  volumeDelta: number;        // currentVolume - previousVolume
}

export interface ProRataShare {
  tokenId: number;
  mintAddress: string;
  deployerSolAddress: string;
  volumeDelta: number;
  sharePercent: number;        // 0–1 (proportion of total volume delta)
  totalAmountLamports: number; // This token's share of the bulk claim
  submitterLamports: number;   // After applying the submitter share %
}

export interface BulkClaimResult {
  success: boolean;
  batchId?: number;
  tokensCount?: number;
  distributedLamports?: number;
  error?: string;
  allocations?: ProRataShare[];
}

// ---------------------------------------------------------------------------
// Pump.fun API — fetch coin data per token
// ---------------------------------------------------------------------------

interface PumpCoinData {
  mint?: string;
  bonding_curve?: string;
  associated_bonding_curve?: string;
  usd_market_cap?: number;
  market_cap?: number;
  real_sol_reserves?: number;
  real_token_reserves?: number;
  virtual_sol_reserves?: number;
  total_supply?: number;
  complete?: boolean;
}

/**
 * Fetch coin data from pump.fun API for a single mint.
 * Tries v3 first, falls back to v1.
 */
async function fetchPumpCoinData(mintAddress: string): Promise<PumpCoinData | null> {
  for (const baseUrl of [PUMP_API_V3, PUMP_API_V1]) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(`${baseUrl}/${mintAddress}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) continue;

      const data = await response.json();
      return data as PumpCoinData;
    } catch {
      // Try next URL
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helius — fetch actual SOL volume per bonding curve
// ---------------------------------------------------------------------------

/**
 * Sum the absolute SOL volume flowing through a bonding curve by parsing
 * Helius enhanced transactions.  Each SWAP transaction's nativeTransfers
 * that involve the bonding curve represent actual trade volume in SOL.
 *
 * Returns cumulative SOL volume in lamports.
 */
async function fetchBondingCurveVolume(
  bondingCurveAddress: string,
): Promise<number> {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) return 0;

  let totalVolumeLamports = 0;
  let beforeSignature: string | undefined;

  for (let page = 0; page < MAX_HELIUS_PAGES; page++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      let url =
        `https://api.helius.xyz/v0/addresses/${bondingCurveAddress}/transactions` +
        `?api-key=${heliusKey}&limit=100&type=SWAP`;
      if (beforeSignature) {
        url += `&before=${beforeSignature}`;
      }

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) break;

      const txs = (await response.json()) as Array<{
        signature: string;
        nativeTransfers?: Array<{
          fromUserAccount: string;
          toUserAccount: string;
          amount: number;
        }>;
      }>;

      if (txs.length === 0) break;

      for (const tx of txs) {
        if (!tx.nativeTransfers) continue;
        for (const nt of tx.nativeTransfers) {
          // SOL flowing INTO the bonding curve = buy
          if (nt.toUserAccount === bondingCurveAddress) {
            totalVolumeLamports += nt.amount;
          }
          // SOL flowing OUT of the bonding curve = sell
          if (nt.fromUserAccount === bondingCurveAddress) {
            totalVolumeLamports += nt.amount;
          }
        }
      }

      // Prepare pagination cursor
      beforeSignature = txs[txs.length - 1].signature;

      // If fewer than limit, we've reached the end
      if (txs.length < 100) break;

      // Small delay between pages
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      break;
    }
  }

  return totalVolumeLamports;
}

/**
 * Fetch trading activity metrics for all active tokens.
 *
 * Strategy:
 * 1. Get each token's bonding curve address from pump.fun API
 * 2. Query Helius for actual SOL volume per bonding curve (most accurate)
 * 3. If Helius is unavailable, fall back to usd_market_cap as proxy
 *
 * Returns an array of TokenVolume objects with delta calculation.
 */
export async function fetchTokenVolumes(tokens: Token[]): Promise<TokenVolume[]> {
  const volumes: TokenVolume[] = [];
  const heliusAvailable = !!process.env.HELIUS_API_KEY;

  console.log(
    `[ClaimDistributor] Fetching activity data for ${tokens.length} token(s) ` +
    `(source: ${heliusAvailable ? "Helius trade history" : "pump.fun market cap fallback"})`
  );

  for (const token of tokens) {
    if (!token.mint_address) continue;

    // Step 1: Fetch pump.fun coin data (always needed for bonding curve address)
    const coinData = await fetchPumpCoinData(token.mint_address);

    let currentVolume = 0;

    if (heliusAvailable && coinData?.bonding_curve) {
      // Step 2a: Use Helius to get actual SOL volume through the bonding curve
      const volumeLamports = await fetchBondingCurveVolume(coinData.bonding_curve);
      // Convert to SOL for a human-readable metric
      currentVolume = volumeLamports / LAMPORTS_PER_SOL;
    } else if (coinData) {
      // Step 2b: Fall back to market cap as proxy
      currentVolume = coinData.usd_market_cap ?? coinData.market_cap ?? 0;
    }

    // Get previous snapshot for delta calculation
    const lastSnapshot = getLastVolumeSnapshot(token.id);
    const previousVolume = lastSnapshot?.cumulative_volume ?? 0;
    const volumeDelta = Math.max(0, currentVolume - previousVolume);

    volumes.push({
      tokenId: token.id,
      mintAddress: token.mint_address,
      currentVolume,
      previousVolume,
      volumeDelta,
    });

    // Small delay to avoid rate-limiting
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return volumes;
}

// ---------------------------------------------------------------------------
// Pro-rata share calculation
// ---------------------------------------------------------------------------

/**
 * Calculate each token's proportional share of a bulk claim.
 */
export function calculateProRataShares(
  volumes: TokenVolume[],
  tokens: Token[],
  totalClaimLamports: number
): ProRataShare[] {
  const submitterSharePercent = getSubmitterSharePercent();

  // Total volume delta across all tokens
  const totalDelta = volumes.reduce((sum, v) => sum + v.volumeDelta, 0);

  // If no volume delta at all, fall back to equal distribution
  const useEqualSplit = totalDelta === 0;
  const activeCount = volumes.filter((v) => v.volumeDelta > 0 || useEqualSplit).length;

  if (activeCount === 0) return [];

  const tokenMap = new Map(tokens.map((t) => [t.id, t]));
  const shares: ProRataShare[] = [];

  for (const vol of volumes) {
    const token = tokenMap.get(vol.tokenId);
    if (!token) continue;

    // Skip tokens with no volume delta (unless doing equal split)
    if (!useEqualSplit && vol.volumeDelta === 0) continue;

    const sharePercent = useEqualSplit
      ? 1 / activeCount
      : vol.volumeDelta / totalDelta;

    const totalAmountLamports = Math.floor(totalClaimLamports * sharePercent);
    const submitterLamports = Math.floor(totalAmountLamports * submitterSharePercent);

    shares.push({
      tokenId: vol.tokenId,
      mintAddress: vol.mintAddress,
      deployerSolAddress: token.deployer_sol_address,
      volumeDelta: vol.volumeDelta,
      sharePercent,
      totalAmountLamports,
      submitterLamports,
    });
  }

  return shares;
}

// ---------------------------------------------------------------------------
// Distribution execution
// ---------------------------------------------------------------------------

/**
 * Distribute a bulk pump.fun claim across all active tokens pro-rata.
 *
 * @param txSignature - The Solana transaction signature of the claim (for idempotency)
 * @param totalLamports - Total SOL received in lamports
 * @param dryRun - If true, calculate shares but don't send SOL or write to DB
 */
export async function distributeBulkClaim(
  txSignature: string,
  totalLamports: number,
  dryRun: boolean = false
): Promise<BulkClaimResult> {
  console.log(
    `[ClaimDistributor] Processing bulk claim: ${totalLamports / LAMPORTS_PER_SOL} SOL ` +
    `(tx: ${txSignature.slice(0, 12)}…)${dryRun ? " [DRY RUN]" : ""}`
  );

  // Guard: minimum amount
  if (totalLamports < MIN_CLAIM_LAMPORTS) {
    return { success: false, error: `Claim too small: ${totalLamports} lamports` };
  }

  // Idempotency: skip if already processed
  if (!dryRun) {
    const existing = getClaimBatchByTxSignature(txSignature);
    if (existing) {
      console.log(`[ClaimDistributor] Batch already exists for tx ${txSignature.slice(0, 12)}… (status: ${existing.status})`);
      return { success: false, error: `Already processed (batch #${existing.id})` };
    }
  }

  // Fetch all active tokens
  const tokens = getActiveTokensForClaim();
  if (tokens.length === 0) {
    return { success: false, error: "No active tokens with mint addresses" };
  }

  console.log(`[ClaimDistributor] Found ${tokens.length} active token(s)`);

  // Fetch trading volumes from pump.fun API
  const volumes = await fetchTokenVolumes(tokens);

  // Calculate pro-rata shares
  const shares = calculateProRataShares(volumes, tokens, totalLamports);
  if (shares.length === 0) {
    return { success: false, error: "No tokens qualify for distribution (zero volume)" };
  }

  console.log(`[ClaimDistributor] Distribution plan:`);
  for (const share of shares) {
    const token = tokens.find((t) => t.id === share.tokenId);
    console.log(
      `  ${token?.ticker || `#${share.tokenId}`}: ` +
      `${(share.sharePercent * 100).toFixed(2)}% → ` +
      `${share.totalAmountLamports / LAMPORTS_PER_SOL} SOL total, ` +
      `${share.submitterLamports / LAMPORTS_PER_SOL} SOL to submitter`
    );
  }

  // Dry run stops here
  if (dryRun) {
    return {
      success: true,
      tokensCount: shares.length,
      distributedLamports: shares.reduce((s, a) => s + a.submitterLamports, 0),
      allocations: shares,
    };
  }

  // Create the claim batch record
  const batch = createClaimBatch(txSignature, totalLamports, shares.length);
  console.log(`[ClaimDistributor] Created batch #${batch.id}`);
  updateClaimBatchStatus(batch.id, "distributing");

  // Create allocation records and distribute
  let distributedLamports = 0;

  for (const share of shares) {
    // Save volume snapshot for this token (for delta calculation next time)
    const vol = volumes.find((v) => v.tokenId === share.tokenId);
    if (vol) {
      saveVolumeSnapshot(share.tokenId, vol.currentVolume, "pump_api");
    }

    // Create allocation record
    const allocation = createClaimAllocation(
      batch.id,
      share.tokenId,
      vol?.currentVolume ?? 0,
      share.sharePercent,
      share.totalAmountLamports,
      share.submitterLamports
    );

    // Skip if submitter share is below dust threshold
    if (share.submitterLamports < MIN_DISTRIBUTION_LAMPORTS) {
      console.log(
        `[ClaimDistributor] Skipping ${share.mintAddress.slice(0, 8)}… ` +
        `(${share.submitterLamports / LAMPORTS_PER_SOL} SOL below minimum)`
      );
      updateClaimAllocationStatus(allocation.id, "skipped");
      continue;
    }

    // Validate recipient address
    if (!isValidSolanaAddress(share.deployerSolAddress)) {
      console.error(`[ClaimDistributor] Invalid address for token #${share.tokenId}: ${share.deployerSolAddress}`);
      updateClaimAllocationStatus(allocation.id, "failed");
      continue;
    }

    // Send SOL to submitter
    try {
      const result = await secureSendSol(
        share.deployerSolAddress,
        share.submitterLamports,
        "claim-distributor"
      );

      if (result.success) {
        updateClaimAllocationStatus(allocation.id, "paid", result.signature);
        distributedLamports += share.submitterLamports;
        console.log(
          `[ClaimDistributor] Paid ${share.submitterLamports / LAMPORTS_PER_SOL} SOL ` +
          `to ${share.deployerSolAddress.slice(0, 8)}… (tx: ${result.signature?.slice(0, 12)}…)`
        );

        const paidToken = tokens.find((t) => t.id === share.tokenId);
        if (paidToken?.submission_id) {
          const submission = getSubmissionById(paidToken.submission_id);
          if (submission) {
            recordEarning({
              telegramUserId: submission.telegram_user_id,
              telegramUsername: submission.telegram_username ?? null,
              solAddress: submission.sol_address,
              amountLamports: share.submitterLamports,
              source: "claim_allocation",
              sourceId: allocation.id,
              tokenTicker: paidToken.ticker,
              txSignature: result.signature,
            });
          }
        }
      } else {
        console.error(`[ClaimDistributor] Payment failed for token #${share.tokenId}: ${result.error}`);
        updateClaimAllocationStatus(allocation.id, "failed");
      }
    } catch (err) {
      console.error(`[ClaimDistributor] Error paying token #${share.tokenId}:`, err);
      updateClaimAllocationStatus(allocation.id, "failed");
    }

    // Small delay between transfers
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Finalize batch
  const allAllocations = getClaimAllocationsByBatch(batch.id);
  const anyFailed = allAllocations.some((a) => a.status === "failed");
  const finalStatus = anyFailed ? "failed" : "completed";

  updateClaimBatchStatus(batch.id, finalStatus, distributedLamports);

  console.log(
    `[ClaimDistributor] Batch #${batch.id} ${finalStatus}: ` +
    `distributed ${distributedLamports / LAMPORTS_PER_SOL} SOL across ${shares.length} token(s)`
  );

  return {
    success: true,
    batchId: batch.id,
    tokensCount: shares.length,
    distributedLamports,
    allocations: shares,
  };
}

// ---------------------------------------------------------------------------
// Re-process a pending/failed batch
// ---------------------------------------------------------------------------

/**
 * Retry failed allocations within an existing batch.
 */
export async function retryFailedAllocations(batchId: number): Promise<{
  retried: number;
  succeeded: number;
  failed: number;
}> {
  const allocations = getClaimAllocationsByBatch(batchId);
  const failedAllocations = allocations.filter((a) => a.status === "failed");

  let retried = 0;
  let succeeded = 0;
  let failed = 0;

  for (const allocation of failedAllocations) {
    retried++;
    const token = getTokenById(allocation.token_id);
    if (!token) {
      failed++;
      continue;
    }

    if (!isValidSolanaAddress(token.deployer_sol_address)) {
      failed++;
      continue;
    }

    try {
      const result = await secureSendSol(
        token.deployer_sol_address,
        allocation.submitter_lamports,
        "claim-distributor-retry"
      );

      if (result.success) {
        updateClaimAllocationStatus(allocation.id, "paid", result.signature);
        succeeded++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { retried, succeeded, failed };
}
