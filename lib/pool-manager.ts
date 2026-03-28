/**
 * Deployer wallet pool manager.
 *
 * Shared logic for pre-funding wallets into the pool and recovering
 * stranded SOL from failed/stale pool entries.
 *
 * Used by:
 *   - scripts/prefund-wallets.ts  (manual CLI)
 *   - worker/scheduler.ts         (auto-refill cron)
 *   - scripts/sweep-pool.ts       (manual recovery CLI)
 */

import {
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  addPoolWallet,
  getPoolStats,
  getRecoverablePoolWallets,
  markPoolWalletSwept,
  resetStaleReservations,
} from "./db";
import { encryptPrivateKey } from "./secrets-provider";
import {
  getConnection,
} from "./solana-wallet";
import {
  secureGetWallet,
  secureGetBalance,
  checkOperation,
} from "./secure-wallet";
import { confirmTransactionPolling } from "./solana-wallet";
import {
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import type { PoolWallet, PoolStats } from "./types";

// Funding amount per pool wallet (same as EPHEMERAL_FUND_SOL in pump-deployer)
const POOL_FUND_SOL = 0.035;
const POOL_FUND_LAMPORTS = Math.floor(POOL_FUND_SOL * LAMPORTS_PER_SOL);

export interface FundResult {
  funded: number;
  failed: number;
  totalSolSpent: number;
  errors: string[];
}

export interface SweepResult {
  swept: number;
  failed: number;
  totalSolRecovered: number;
  errors: string[];
}

/**
 * Pre-fund N new wallets into the deployer pool.
 *
 * Generates keypairs, transfers SOL from the master wallet, encrypts
 * private keys, and stores them in the deployer_pool table.
 */
export async function fundPoolWallets(
  count: number,
  options: { dryRun?: boolean } = {}
): Promise<FundResult> {
  const result: FundResult = { funded: 0, failed: 0, totalSolSpent: 0, errors: [] };

  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey || encryptionKey.length < 32) {
    result.errors.push("WALLET_ENCRYPTION_KEY must be set and at least 32 characters — cannot encrypt pool wallet keys");
    return result;
  }

  const connection = getConnection();
  const masterWallet = secureGetWallet("pool-manager:fund");

  // Check master wallet balance upfront
  const { sol: masterBalance } = await secureGetBalance("pool-manager:fund");
  const totalNeeded = count * POOL_FUND_SOL;
  if (masterBalance < totalNeeded + 0.01) { // +0.01 SOL buffer for fees
    result.errors.push(
      `Insufficient master wallet balance: ${masterBalance.toFixed(4)} SOL ` +
      `(need ~${totalNeeded.toFixed(4)} SOL for ${count} wallets)`
    );
    return result;
  }

  console.log(
    `[PoolManager] Funding ${count} pool wallets ` +
    `(${POOL_FUND_SOL} SOL each, ~${totalNeeded.toFixed(4)} SOL total)` +
    (options.dryRun ? " [DRY RUN]" : "")
  );

  for (let i = 0; i < count; i++) {
    try {
      // Guardrail check per wallet
      const guardrail = checkOperation(POOL_FUND_LAMPORTS, "pool-manager:fund");
      if (!guardrail.allowed) {
        result.errors.push(`Wallet ${i + 1}: guardrail blocked — ${guardrail.reason}`);
        result.failed++;
        continue;
      }

      // Generate fresh keypair
      const wallet = Keypair.generate();
      const address = wallet.publicKey.toBase58();
      const base58Key = bs58.encode(Buffer.from(wallet.secretKey));

      if (options.dryRun) {
        console.log(`  [${i + 1}/${count}] Would fund ${address} with ${POOL_FUND_SOL} SOL`);
        result.funded++;
        result.totalSolSpent += POOL_FUND_SOL;
        continue;
      }

      // Transfer SOL from master wallet
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: masterWallet.publicKey,
          toPubkey: wallet.publicKey,
          lamports: POOL_FUND_LAMPORTS,
        })
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = masterWallet.publicKey;
      tx.sign(masterWallet);

      const signature = await connection.sendRawTransaction(tx.serialize(), {
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

      // Encrypt and store
      const encryptedKey = encryptPrivateKey(base58Key, encryptionKey);
      addPoolWallet(address, encryptedKey, POOL_FUND_LAMPORTS);

      result.funded++;
      result.totalSolSpent += POOL_FUND_SOL;
      console.log(
        `  [${i + 1}/${count}] Funded ${address} — ${POOL_FUND_SOL} SOL (tx: ${signature})`
      );

      // Small delay between funding transactions to avoid RPC rate limits
      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`Wallet ${i + 1}: ${msg}`);
      result.failed++;
      console.error(`  [${i + 1}/${count}] FAILED: ${msg}`);
    }
  }

  return result;
}

/**
 * Sweep SOL from recoverable pool wallets back to the master wallet.
 *
 * Targets wallets in "ready", "reserved", or "failed" status that may
 * still hold SOL on-chain. After sweeping, marks them as "used" so they
 * are not reused or swept again.
 *
 * @param options.dryRun  If true, just report what would be swept.
 * @param options.statusFilter  Only sweep wallets with these statuses (default: all recoverable).
 */
export async function sweepPoolWallets(
  options: {
    dryRun?: boolean;
    statusFilter?: Array<"ready" | "reserved" | "failed">;
  } = {}
): Promise<SweepResult> {
  const result: SweepResult = { swept: 0, failed: 0, totalSolRecovered: 0, errors: [] };

  const encryptionKey = process.env.WALLET_ENCRYPTION_KEY;
  if (!encryptionKey || encryptionKey.length < 32) {
    result.errors.push("WALLET_ENCRYPTION_KEY must be set and at least 32 characters — cannot decrypt pool wallet keys");
    return result;
  }

  const connection = getConnection();
  const masterWallet = secureGetWallet("pool-manager:sweep");
  const masterPubkey = masterWallet.publicKey;

  // Reset stale reservations first so they become sweepable
  const staleReset = resetStaleReservations(30);
  if (staleReset > 0) {
    console.log(`[PoolManager] Reset ${staleReset} stale reservation(s) back to "ready"`);
  }

  let wallets: PoolWallet[] = getRecoverablePoolWallets();

  // Filter by status if requested
  if (options.statusFilter) {
    wallets = wallets.filter((w) => options.statusFilter!.includes(w.status as "ready" | "reserved" | "failed"));
  }

  if (wallets.length === 0) {
    console.log("[PoolManager] No recoverable pool wallets found");
    return result;
  }

  console.log(
    `[PoolManager] Sweeping ${wallets.length} pool wallet(s)` +
    (options.dryRun ? " [DRY RUN]" : "")
  );

  for (const poolWallet of wallets) {
    try {
      // Decrypt the private key
      const { decryptPrivateKey } = await import("./secrets-provider");
      const base58Key = decryptPrivateKey(poolWallet.encrypted_key, encryptionKey);
      const wallet = Keypair.fromSecretKey(bs58.decode(base58Key));

      // Check on-chain balance
      const balance = await connection.getBalance(wallet.publicKey);
      const fee = 5_000; // standard transaction fee
      const sweepAmount = balance - fee;

      if (sweepAmount <= 0) {
        console.log(
          `  ${poolWallet.address}: 0 SOL (empty) — marking as used`
        );
        if (!options.dryRun) {
          markPoolWalletSwept(poolWallet.id);
        }
        continue;
      }

      const solAmount = sweepAmount / LAMPORTS_PER_SOL;

      if (options.dryRun) {
        console.log(
          `  ${poolWallet.address}: ${solAmount.toFixed(6)} SOL (status: ${poolWallet.status})`
        );
        result.swept++;
        result.totalSolRecovered += solAmount;
        continue;
      }

      // Build and send sweep transaction
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: masterPubkey,
          lamports: sweepAmount,
        })
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      tx.sign(wallet);

      const signature = await connection.sendRawTransaction(tx.serialize(), {
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

      markPoolWalletSwept(poolWallet.id);
      result.swept++;
      result.totalSolRecovered += solAmount;
      console.log(
        `  ${poolWallet.address}: swept ${solAmount.toFixed(6)} SOL (tx: ${signature})`
      );

      // Small delay between sweeps
      await new Promise((r) => setTimeout(r, 1000));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`${poolWallet.address}: ${msg}`);
      result.failed++;
      console.error(`  ${poolWallet.address}: SWEEP FAILED — ${msg}`);
    }
  }

  return result;
}

/**
 * Get current pool stats (convenience re-export for scripts).
 */
export { getPoolStats };
export type { PoolStats };
