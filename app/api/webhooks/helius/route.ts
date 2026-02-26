/**
 * Helius Webhook Endpoint
 *
 * Receives transaction notifications from Helius when the master wallet
 * receives SOL (i.e. creator fees from pump.fun). Matches the transaction
 * to a deployed token and triggers revenue distribution (50% to submitter,
 * 50% retained in creator wallet).
 *
 * Setup:
 * 1. Create a webhook at https://dashboard.helius.dev/webhooks
 * 2. Set the webhook URL to: https://yoursite.com/api/webhooks/helius
 * 3. Set the webhook type to "enhanced" transactions
 * 4. Filter to your master wallet address
 * 5. Set HELIUS_WEBHOOK_SECRET in your .env
 */

import { NextRequest, NextResponse } from "next/server";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getTokenByMintAddress, isKnownCreatorWallet } from "@/lib/db";
import { safeCompare } from "@/lib/auth";

const MASTER_WALLET = process.env.MASTER_WALLET_PUBLIC_KEY || "";

// Minimum amount to process (avoid dust transactions)
const MIN_REVENUE_LAMPORTS = 10_000; // 0.00001 SOL


// Addresses to IGNORE incoming transfers from (e.g. your personal wallets used to top off).
// Comma-separated in .env.local: WEBHOOK_IGNORE_SENDERS=addr1,addr2
const IGNORED_SENDERS = new Set(
  (process.env.WEBHOOK_IGNORE_SENDERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// Replay protection: track processed transaction signatures
const processedSignatures = new Map<string, number>(); // signature → timestamp
const MAX_PROCESSED_SIGNATURES = 2_000;
const SIGNATURE_TTL_MS = 24 * 60 * 60 * 1000; // Keep for 24 hours

// Max webhook age to accept (prevent replay of very old webhooks)
const MAX_WEBHOOK_AGE_SECONDS = 300; // 5 minutes

// Max transactions per webhook payload
const MAX_TRANSACTIONS_PER_PAYLOAD = 50;

function isSignatureProcessed(signature: string): boolean {
  return processedSignatures.has(signature);
}

function markSignatureProcessed(signature: string): void {
  processedSignatures.set(signature, Date.now());
  // Prune old entries if the map grows too large
  if (processedSignatures.size > MAX_PROCESSED_SIGNATURES) {
    const now = Date.now();
    for (const [sig, ts] of processedSignatures) {
      if (now - ts > SIGNATURE_TTL_MS) {
        processedSignatures.delete(sig);
      }
    }
  }
}

// Periodically evict expired signatures to prevent unbounded growth between bursts
setInterval(() => {
  const now = Date.now();
  for (const [sig, ts] of processedSignatures) {
    if (now - ts > SIGNATURE_TTL_MS) {
      processedSignatures.delete(sig);
    }
  }
}, 30 * 60 * 1000);

/**
 * Verify the webhook request is from Helius.
 * SECURITY: Defaults to DENY when the secret is not configured.
 */
function verifyWebhook(request: NextRequest): boolean {
  const webhookSecret = process.env.HELIUS_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("[HeliusWebhook] HELIUS_WEBHOOK_SECRET not configured — rejecting request");
    return false;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;

  // Timing-safe comparison to prevent brute-force via side-channels
  return (
    safeCompare(authHeader, webhookSecret) ||
    safeCompare(authHeader, `Bearer ${webhookSecret}`)
  );
}

/**
 * Extract incoming SOL transfers to the master wallet from a Helius enhanced transaction.
 */
function extractIncomingTransfers(tx: HeliusTransaction): Array<{
  fromAddress: string;
  lamports: number;
  relatedMint?: string;
}> {
  const transfers: Array<{
    fromAddress: string;
    lamports: number;
    relatedMint?: string;
  }> = [];

  // Check native SOL transfers
  if (tx.nativeTransfers) {
    for (const transfer of tx.nativeTransfers) {
      if (
        transfer.toUserAccount === MASTER_WALLET &&
        transfer.amount >= MIN_REVENUE_LAMPORTS
      ) {
        transfers.push({
          fromAddress: transfer.fromUserAccount,
          lamports: transfer.amount,
          relatedMint: undefined,
        });
      }
    }
  }

  // Try to identify the related token mint from account data / token transfers
  if (tx.tokenTransfers) {
    for (const tt of tx.tokenTransfers) {
      if (tt.mint) {
        // If there's a token transfer in the same tx, associate the mint
        for (const t of transfers) {
          if (!t.relatedMint) {
            t.relatedMint = tt.mint;
          }
        }
      }
    }
  }

  return transfers;
}

/**
 * Try to match an incoming transfer to a token we deployed.
 * SECURITY: Only matches by explicit mint address — no dangerous fallbacks.
 */
function matchToToken(transfer: {
  fromAddress: string;
  lamports: number;
  relatedMint?: string;
}): number | null {
  // Only match by mint address — no guessing
  if (transfer.relatedMint) {
    const token = getTokenByMintAddress(transfer.relatedMint);
    if (token) return token.id;
  }

  return null;
}

// Helius enhanced transaction types
interface HeliusTransaction {
  signature: string;
  type: string;
  timestamp: number;
  nativeTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }>;
  tokenTransfers?: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    mint: string;
    tokenAmount: number;
  }>;
  accountData?: Array<{
    account: string;
    nativeBalanceChange: number;
  }>;
}

/**
 * POST /api/webhooks/helius
 *
 * Receives Helius webhook payloads for master wallet transactions.
 */
export async function POST(request: NextRequest) {
  // Verify webhook authenticity
  if (!verifyWebhook(request)) {
    console.warn("[HeliusWebhook] Unauthorized request rejected");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    // Helius sends an array of transactions
    const transactions: HeliusTransaction[] = Array.isArray(body) ? body : [body];

    // Limit payload size to prevent DoS
    if (transactions.length > MAX_TRANSACTIONS_PER_PAYLOAD) {
      console.warn(`[HeliusWebhook] Payload too large: ${transactions.length} transactions (max ${MAX_TRANSACTIONS_PER_PAYLOAD})`);
      return NextResponse.json(
        { error: "Payload too large" },
        { status: 413 }
      );
    }

    console.log(
      `[HeliusWebhook] Received ${transactions.length} transaction(s)`
    );

    let processed = 0;
    let distributed = 0;
    let skippedReplay = 0;

    for (const tx of transactions) {
      // Validate transaction has a signature
      if (!tx.signature || typeof tx.signature !== "string") {
        console.warn("[HeliusWebhook] Transaction missing signature, skipping");
        continue;
      }

      // Replay protection: skip already-processed signatures
      if (isSignatureProcessed(tx.signature)) {
        console.log(`[HeliusWebhook] Skipping already-processed tx ${tx.signature}`);
        skippedReplay++;
        continue;
      }

      // Timestamp validation: reject very old transactions
      if (tx.timestamp) {
        const txAgeSeconds = Math.floor(Date.now() / 1000) - tx.timestamp;
        if (txAgeSeconds > MAX_WEBHOOK_AGE_SECONDS) {
          console.warn(`[HeliusWebhook] Stale tx ${tx.signature} (${txAgeSeconds}s old), skipping`);
          continue;
        }
      }

      // Mark as processed BEFORE distribution to prevent race conditions
      markSignatureProcessed(tx.signature);

      processed++;
      console.log(
        `[HeliusWebhook] Processing tx ${tx.signature} (type: ${tx.type})`
      );

      // Extract incoming SOL transfers to the master wallet
      const transfers = extractIncomingTransfers(tx);

      for (const transfer of transfers) {
        // Skip internal sweeps from ephemeral deployer wallets
        if (isKnownCreatorWallet(transfer.fromAddress)) {
          console.log(
            `[HeliusWebhook] Skipping internal sweep from deployer wallet ${transfer.fromAddress.slice(0, 8)}…`
          );
          continue;
        }

        // Skip transfers from ignored senders (personal wallets used to top off)
        if (IGNORED_SENDERS.has(transfer.fromAddress)) {
          console.log(
            `[HeliusWebhook] Skipping top-off deposit from ignored sender ${transfer.fromAddress.slice(0, 8)}… (${transfer.lamports / LAMPORTS_PER_SOL} SOL)`
          );
          continue;
        }

        console.log(
          `[HeliusWebhook] Incoming: ${transfer.lamports / LAMPORTS_PER_SOL} SOL`
        );

        // Log only — no automatic distribution.
        // Fees are claimed every 30 min by the fee claimer and kept in the master wallet.
        const tokenId = matchToToken(transfer);
        console.log(
          `[HeliusWebhook] Incoming ${transfer.lamports / LAMPORTS_PER_SOL} SOL ` +
          `from ${transfer.fromAddress.slice(0, 8)}… ` +
          (tokenId ? `(matched token #${tokenId})` : "(unmatched)") +
          ` — logged, no auto-distribution`
        );
      }
    }

    return NextResponse.json({
      success: true,
      processed,
      distributed,
      skippedReplay,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("[HeliusWebhook] Error processing webhook:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/webhooks/helius
 * Minimal health check — no service information leaked.
 */
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
