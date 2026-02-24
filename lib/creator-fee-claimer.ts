/**
 * Creator Fee Claimer — collects accumulated pump.fun creator fees
 * from the master wallet.
 *
 * All tokens are deployed directly from the master wallet, so a single
 * `collectCreatorFee` call claims fees for every token at once.
 *
 * Runs every 30 minutes via the scheduler cron.
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getConnection,
  confirmTransactionPolling,
} from "./solana-wallet";
import {
  secureGetWallet,
} from "./secure-wallet";
import { logWalletOperation } from "./wallet-audit";
import { distributeBulkClaim } from "./claim-distributor";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** PumpPortal Local Transaction API endpoint. */
const PUMPPORTAL_API_URL = "https://pumpportal.fun/api/trade-local";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaimResult {
  tokenId: number;
  ticker: string;
  success: boolean;
  claimedLamports?: number;
  txSignature?: string;
  error?: string;
}

export interface ClaimCycleResult {
  processed: number;
  claimed: number;
  failed: number;
  totalClaimedLamports: number;
  results: ClaimResult[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse the confirmed claim transaction to extract the exact SOL received
 * by the master wallet, immune to concurrent transfers inflating the amount.
 */
async function getClaimedLamportsFromTx(
  connection: Connection,
  signature: string,
  walletPubkey: Keypair["publicKey"],
): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const txInfo = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (txInfo?.meta) {
      const keys = txInfo.transaction.message.staticAccountKeys;
      const idx = keys.findIndex((k) => k.equals(walletPubkey));
      if (idx >= 0) {
        return Math.max(0, txInfo.meta.postBalances[idx] - txInfo.meta.preBalances[idx]);
      }
      return 0;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }
  return 0;
}

/**
 * Claim creator fees from the master wallet.
 * One call collects fees for ALL tokens deployed with this wallet.
 * After a successful claim, automatically distributes 50% to submitters
 * via the bulk claim distributor.
 *
 * Called every 30 minutes by the scheduler.
 */
export async function claimAllCreatorFees(): Promise<ClaimCycleResult> {
  const connection = getConnection();
  const masterWallet = secureGetWallet("fee-claimer");

  try {
    console.log("[FeeClaimer] Claiming master wallet creator fees...");

    const signature = await callCollectCreatorFee(connection, masterWallet);
    console.log(`[FeeClaimer] Master wallet claim tx: ${signature}`);

    const claimedLamports = await getClaimedLamportsFromTx(
      connection, signature, masterWallet.publicKey,
    );

    console.log(`[FeeClaimer] Claimed: ${claimedLamports / LAMPORTS_PER_SOL} SOL`);

    logWalletOperation({
      operation: "claim_creator_fee",
      caller: "fee-claimer:master",
      success: true,
      txSignature: signature,
      amountLamports: claimedLamports,
    });

    if (claimedLamports > 0) {
      console.log(`[FeeClaimer] Auto-distributing ${claimedLamports / LAMPORTS_PER_SOL} SOL to submitters...`);
      try {
        const distResult = await distributeBulkClaim(signature, claimedLamports);
        if (distResult.success) {
          console.log(
            `[FeeClaimer] Distribution complete: batch #${distResult.batchId}, ` +
            `${distResult.distributedLamports! / LAMPORTS_PER_SOL} SOL across ${distResult.tokensCount} token(s)`
          );
        } else {
          console.warn(`[FeeClaimer] Distribution skipped: ${distResult.error}`);
        }
      } catch (distErr) {
        console.error("[FeeClaimer] Distribution error (claim was successful):", distErr);
      }
    }

    return {
      processed: 1,
      claimed: 1,
      failed: 0,
      totalClaimedLamports: claimedLamports,
      results: [],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // A 400/500 from PumpPortal likely means "no fees to claim" — not a real error
    if (msg.includes("400") || msg.includes("500") || msg.includes("No fees")) {
      console.log("[FeeClaimer] Master wallet: no fees to claim (or API unavailable)");
      return { processed: 1, claimed: 0, failed: 0, totalClaimedLamports: 0, results: [] };
    }

    console.error("[FeeClaimer] Master wallet claim failed:", msg);
    logWalletOperation({
      operation: "claim_creator_fee",
      caller: "fee-claimer:master",
      success: false,
      errorMessage: msg,
    });

    return { processed: 1, claimed: 0, failed: 1, totalClaimedLamports: 0, results: [] };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Call PumpPortal's collectCreatorFee Local Transaction API.
 * Returns the confirmed transaction signature.
 */
export async function callCollectCreatorFee(
  connection: Connection,
  wallet: Keypair
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let txData: ArrayBuffer;
  try {
    const response = await fetch(PUMPPORTAL_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: wallet.publicKey.toBase58(),
        action: "collectCreatorFee",
        priorityFee: 0.000001,
        pool: "pump",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `PumpPortal collectCreatorFee error: ${response.status} - ${errorText}`
      );
    }

    txData = await response.arrayBuffer();
  } finally {
    clearTimeout(timeout);
  }

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
  tx.sign([wallet]);

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  await confirmTransactionPolling(
    connection,
    signature,
    blockhash,
    lastValidBlockHeight,
    "confirmed"
  );

  return signature;
}
