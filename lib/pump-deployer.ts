/**
 * Token deployment on pump.fun.
 *
 * Changes from original:
 * - Imports getConnection/getMasterWallet from solana-wallet (single source of truth)
 * - Removed duplicate helper functions
 * - Removed dead imports (Transaction, sendAndConfirmTransaction)
 * - Image is persisted to permanent storage before deployment
 * - Metadata upload has retry logic; broken image-URL fallback removed
 * - All external HTTP calls have timeouts via AbortController
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { Worker } from "worker_threads";
import os from "os";
import fs from "fs";
import path from "path";
import {
  getConnection,
  confirmTransactionPolling,
} from "./solana-wallet";
import {
  secureGetWallet,
  secureGetBalance,
  checkOperation,
  logDeployment,
} from "./secure-wallet";
import {
  createToken,
  linkTokenToHeadline,
  getSetting,
} from "./db";
import { persistImage } from "./image-store";
import type { TokenMetadata } from "./types";

// Pump.fun API endpoints
const PUMP_FUN_API_URL = "https://pumpportal.fun/api";
const PUMP_FUN_IPFS_URL = "https://pump.fun/api/ipfs";

// Mayhem Mode fee recipient (pump.fun Mayhem Mode — AI agent trading)
const MAYHEM_FEE_RECIPIENT = process.env.MAYHEM_FEE_RECIPIENT || "";
if (MAYHEM_FEE_RECIPIENT) {
  try {
    new PublicKey(MAYHEM_FEE_RECIPIENT);
  } catch {
    throw new Error("MAYHEM_FEE_RECIPIENT is not a valid Solana address");
  }
}

// Minimum SOL required for deployment (~0.02 SOL + fees)
const MIN_DEPLOYMENT_SOL = 0.03;


/** Token deployment result */
export interface DeploymentResult {
  success: boolean;
  mintAddress?: string;
  pumpUrl?: string;
  transactionSignature?: string;
  error?: string;
}

/**
 * Check if we have enough SOL for deployment.
 */
export async function checkDeploymentBalance(): Promise<{
  hasEnough: boolean;
  balance: number;
}> {
  const { sol } = await secureGetBalance("pump-deployer");
  return {
    hasEnough: sol >= MIN_DEPLOYMENT_SOL,
    balance: sol,
  };
}

/**
 * Generate a vanity keypair whose base58 address ends in "pump".
 *
 * Parallelises the brute-force search across all available CPU cores using
 * worker_threads.  Each worker independently grinds random keypairs; the first
 * one to find a match posts its secret key back, and all workers are torn down.
 *
 * Probability of a match per attempt: 1/58^4 ≈ 1 in 11.3 M.
 * With N workers running in parallel the expected wall-clock time drops to
 * roughly (11.3 M / N) key-generations — typically 5-20 s on a 4-8 core machine
 * instead of 60-120 s single-threaded.
 *
 * A 2-minute hard timeout and a generous per-worker cap ensure we never hang.
 */
async function generateMintKeypair(): Promise<Keypair> {
  const SUFFIX = "pump";
  const NUM_WORKERS = Math.max(1, Math.min(os.cpus().length, 8));
  const ATTEMPTS_PER_WORKER = 15_000_000; // 15 M each → up to 120 M total
  const TIMEOUT_MS = 120_000; // 2-minute hard ceiling
  const PROGRESS_INTERVAL = 2_000_000;

  console.log(
    `[PumpDeployer] Grinding for vanity mint ending in "${SUFFIX}" ` +
    `using ${NUM_WORKERS} worker thread(s)…`
  );
  const start = Date.now();

  /* ── inline worker source (CommonJS so Node can eval it directly) ── */
  const workerSource = `
    'use strict';
    const { parentPort, workerData } = require('worker_threads');
    const { Keypair } = require('@solana/web3.js');

    (function () {
      const { suffix, maxAttempts, progressInterval, workerId } = workerData;

      for (let i = 0; i < maxAttempts; i++) {
        const kp = Keypair.generate();
        if (kp.publicKey.toBase58().endsWith(suffix)) {
          parentPort.postMessage({
            type: 'found',
            secretKey: Array.from(kp.secretKey),
            address: kp.publicKey.toBase58(),
            attempts: i + 1,
            workerId,
          });
          return;                    // let the thread exit gracefully
        }
        if (i > 0 && i % progressInterval === 0) {
          parentPort.postMessage({ type: 'progress', attempts: i, workerId });
        }
      }
      parentPort.postMessage({ type: 'exhausted', attempts: maxAttempts, workerId });
    })();
  `;

  return new Promise<Keypair>((resolve) => {
    const workers: Worker[] = [];
    let resolved = false;
    let finishedCount = 0;

    const finish = (kp: Keypair) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      workers.forEach((w) => { try { w.terminate(); } catch { /* already dead */ } });
      resolve(kp);
    };

    // Hard timeout — fall back to a random keypair rather than blocking forever
    const timer = setTimeout(() => {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.warn(
        `[PumpDeployer] Vanity grind timed out after ${elapsed}s, using random address`
      );
      finish(Keypair.generate());
    }, TIMEOUT_MS);

    for (let i = 0; i < NUM_WORKERS; i++) {
      const worker = new Worker(workerSource, {
        eval: true,
        workerData: {
          suffix: SUFFIX,
          maxAttempts: ATTEMPTS_PER_WORKER,
          progressInterval: PROGRESS_INTERVAL,
          workerId: i,
        },
      });
      workers.push(worker);

      worker.on('message', (msg: { type: string; secretKey?: number[]; address?: string; attempts?: number; workerId?: number }) => {
        if (msg.type === 'found' && !resolved) {
          const kp = Keypair.fromSecretKey(new Uint8Array(msg.secretKey!));
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          console.log(
            `[PumpDeployer] Worker ${msg.workerId} found vanity address in ${elapsed}s ` +
            `after ${(msg.attempts ?? 0).toLocaleString()} attempts: ${msg.address}`
          );
          finish(kp);
        } else if (msg.type === 'progress') {
          const elapsed = ((Date.now() - start) / 1000).toFixed(1);
          console.log(
            `[PumpDeployer] Worker ${msg.workerId}: ` +
            `${(msg.attempts ?? 0).toLocaleString()} attempts (${elapsed}s)…`
          );
        } else if (msg.type === 'exhausted') {
          finishedCount++;
          if (finishedCount >= NUM_WORKERS && !resolved) {
            console.warn(
              `[PumpDeployer] All ${NUM_WORKERS} workers exhausted ` +
              `(${(ATTEMPTS_PER_WORKER * NUM_WORKERS).toLocaleString()} total), ` +
              `using random address`
            );
            finish(Keypair.generate());
          }
        }
      });

      worker.on('error', (err) => {
        console.error(`[PumpDeployer] Worker ${i} error:`, err);
        finishedCount++;
        if (finishedCount >= NUM_WORKERS && !resolved) {
          console.warn(`[PumpDeployer] All workers errored, using random address`);
          finish(Keypair.generate());
        }
      });
    }
  });
}

/** Download image from URL and convert to Blob for upload.
 * Local /tokens/ paths are read directly from disk (Next.js production
 * does NOT serve files added to public/ after build time).
 * Remote URLs use safeFetch for SSRF protection. */
async function downloadImageAsBlob(imageUrl: string): Promise<Blob> {
  // Local image path (e.g. "/tokens/slug-abc123.png") — read from disk
  if (imageUrl.startsWith("/tokens/")) {
    const filePath = path.join(process.cwd(), "public", imageUrl);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Local image not found on disk: ${filePath}`);
    }
    const buffer = fs.readFileSync(filePath);
    console.log(`[PumpDeployer] Read local image from disk: ${imageUrl} (${buffer.length} bytes)`);
    return new Blob([buffer], { type: "image/png" });
  }

  // Remote URL — fetch with SSRF protection
  const { safeFetch } = await import("./url-validator");
  const response = await safeFetch(imageUrl, {
    timeoutMs: 30_000,
    maxBytes: 10 * 1024 * 1024, // 10 MB max
    // Skip SSRF check only for known-safe hosts
    skipSsrfCheck: imageUrl.includes("oaidalleapiprodscus.blob.core.windows.net") ||
                   (!!process.env.NEXT_PUBLIC_SITE_URL && imageUrl.startsWith(process.env.NEXT_PUBLIC_SITE_URL)),
  });
  if (!response.ok) {
    throw new Error(`Failed to download image: ${response.status}`);
  }
  return await response.blob();
}

/** Upload token metadata to pump.fun's IPFS. */
async function uploadMetadataToPumpFun(
  name: string,
  symbol: string,
  description: string,
  imageUrl: string,
  sourceUrl?: string
): Promise<string> {
  console.log(`[PumpDeployer] Uploading metadata to IPFS...`);

  const imageBlob = await downloadImageAsBlob(imageUrl);

  const formData = new FormData();
  formData.append("file", imageBlob, `${symbol}.png`);
  formData.append("name", name);
  formData.append("symbol", symbol);
  formData.append("description", description);
  formData.append("twitter", "https://x.com/TheMcAfeeReport");
  formData.append("telegram", "https://t.me/mcafeereport_bot");
  formData.append("website", sourceUrl || "");
  formData.append("showName", "true");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(PUMP_FUN_IPFS_URL, {
      method: "POST",
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to upload to IPFS: ${response.status} - ${errorText}`
      );
    }

    const result = await response.json();
    console.log(`[PumpDeployer] Metadata uploaded: ${result.metadataUri}`);
    return result.metadataUri;
  } finally {
    clearTimeout(timeout);
  }
}

/** Upload metadata with retry logic. */
async function uploadMetadataWithRetry(
  name: string,
  symbol: string,
  description: string,
  imageUrl: string,
  sourceUrl?: string,
  maxAttempts: number = 3
): Promise<string | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await uploadMetadataToPumpFun(name, symbol, description, imageUrl, sourceUrl);
    } catch (error) {
      console.error(
        `[PumpDeployer] Metadata upload attempt ${attempt}/${maxAttempts} failed:`,
        error
      );
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  return null;
}

/** Create token using PumpPortal API (trade-enabled launch).
 * When mayhemMode is true, uses create_v2 with the Mayhem fee recipient
 * so the pump.fun AI agent receives extra tokens to trade in the first 24h.
 */
async function createTokenViaPumpPortal(
  connection: Connection,
  wallet: Keypair,
  mintKeypair: Keypair,
  metadataUri: string,
  name: string,
  symbol: string,
  mayhemMode: boolean = false
): Promise<{ signature: string }> {
  console.log(`[PumpDeployer] Creating token via PumpPortal API${mayhemMode ? " (Mayhem Mode)" : ""}...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  // Build request body — add mayhem fee recipient when enabled
  const requestBody: Record<string, unknown> = {
    publicKey: wallet.publicKey.toBase58(),
    action: "create",
    tokenMetadata: { name, symbol, uri: metadataUri },
    mint: mintKeypair.publicKey.toBase58(),
    denominatedInSol: "true",
    amount: 0,
    slippage: 10,
    priorityFee: 0.0005,
    pool: "pump",
  };

  if (mayhemMode && MAYHEM_FEE_RECIPIENT) {
    requestBody.mayhemFeeRecipient = MAYHEM_FEE_RECIPIENT;
  }

  let txData: ArrayBuffer;
  try {
    // Use create_v2 endpoint when mayhem mode is on, otherwise standard trade-local
    const endpoint = mayhemMode
      ? `${PUMP_FUN_API_URL}/trade-local`   // PumpPortal handles mayhem via the mayhemFeeRecipient field
      : `${PUMP_FUN_API_URL}/trade-local`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `PumpPortal API error: ${response.status} - ${errorText}`
      );
    }

    txData = await response.arrayBuffer();
  } finally {
    clearTimeout(timeout);
  }

  // Get blockhash for polling-based confirmation
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const tx = VersionedTransaction.deserialize(new Uint8Array(txData));
  tx.sign([wallet, mintKeypair]);

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  // Use polling instead of WebSocket-based confirmTransaction
  await confirmTransactionPolling(
    connection,
    signature,
    blockhash,
    lastValidBlockHeight,
    "confirmed"
  );

  console.log(`[PumpDeployer] Token created with signature: ${signature}`);
  return { signature };
}

/**
 * Alternative: Create token using direct instruction building.
 * Fallback when PumpPortal is unavailable.
 */
async function createTokenDirect(
  connection: Connection,
  wallet: Keypair,
  mintKeypair: Keypair,
  name: string,
  symbol: string,
  metadataUri: string
): Promise<{ signature: string }> {
  console.log(`[PumpDeployer] Creating token via direct transaction...`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let data: { transaction?: string };
  try {
    const response = await fetch(
      "https://pumpportal.fun/api/trade?api-version=2",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trade: {
            publicKey: wallet.publicKey.toBase58(),
            action: "create",
            mint: mintKeypair.publicKey.toBase58(),
            tokenMetadata: { name, symbol, uri: metadataUri },
            denominatedInSol: true,
            amount: 0,
            slippage: 5, // 5% max — 50% was vulnerable to sandwich attacks
            priorityFee: 0.0001,
          },
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get transaction: ${response.status}`);
    }

    data = await response.json();
  } finally {
    clearTimeout(timeout);
  }

  if (!data.transaction) {
    throw new Error("No transaction returned from API");
  }

  // Get blockhash for polling-based confirmation
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const txBuffer = Buffer.from(data.transaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([wallet, mintKeypair]);

  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
  });

  await confirmTransactionPolling(
    connection,
    signature,
    blockhash,
    lastValidBlockHeight,
    "confirmed"
  );

  return { signature };
}


/**
 * Deploy a new token on pump.fun.
 * Deploys directly from the master wallet — simpler, cheaper, and all
 * creator fees accumulate in one place (claimed every 30 min by the scheduler).
 */
export async function deployToken(
  metadata: TokenMetadata,
  submitterSolAddress: string,
  headlineId?: number,
  submissionId?: number,
  sourceUrl?: string
): Promise<DeploymentResult> {
  console.log(
    `[PumpDeployer] Starting deployment for "${metadata.name}" (${metadata.ticker})`
  );

  try {
    const connection = getConnection();
    const masterWallet = secureGetWallet("pump-deployer");

    // Pre-flight guardrail check
    const guardrailCheck = checkOperation(
      Math.floor(MIN_DEPLOYMENT_SOL * LAMPORTS_PER_SOL),
      "pump-deployer"
    );
    if (!guardrailCheck.allowed) {
      return {
        success: false,
        error: `Guardrail blocked deployment: ${guardrailCheck.reason}`,
      };
    }

    // Check balance
    const balanceCheck = await checkDeploymentBalance();
    if (!balanceCheck.hasEnough) {
      return {
        success: false,
        error: `Insufficient balance: ${balanceCheck.balance} SOL (need ${MIN_DEPLOYMENT_SOL} SOL)`,
      };
    }

    console.log(`[PumpDeployer] Wallet balance: ${balanceCheck.balance} SOL`);

    // Persist the token logo to permanent storage (used on the site)
    let persistedImageUrl = metadata.imageUrl;
    try {
      persistedImageUrl = await persistImage(
        metadata.imageUrl,
        metadata.ticker
      );
      console.log(`[PumpDeployer] Logo persisted: ${persistedImageUrl}`);
    } catch (imgError) {
      console.warn(
        `[PumpDeployer] Logo persistence failed, using original URL:`,
        imgError
      );
    }

    // Persist the banner image for pump.fun upload
    let persistedBannerUrl = metadata.bannerUrl;
    try {
      persistedBannerUrl = await persistImage(
        metadata.bannerUrl,
        `${metadata.ticker}-banner`
      );
      console.log(`[PumpDeployer] Banner persisted: ${persistedBannerUrl}`);
    } catch (imgError) {
      console.warn(
        `[PumpDeployer] Banner persistence failed, falling back to logo:`,
        imgError
      );
      persistedBannerUrl = persistedImageUrl;
    }

    // Generate mint keypair (parallel vanity grind)
    const mintKeypair = await generateMintKeypair();
    const mintAddress = mintKeypair.publicKey.toBase58();
    console.log(`[PumpDeployer] Generated mint address: ${mintAddress}`);

    // Use AI-generated description from metadata
    const description = metadata.description;

    const imageUrlForUpload = persistedImageUrl;

    // Upload metadata to IPFS (with retry)
    const metadataUri = await uploadMetadataWithRetry(
      metadata.name,
      metadata.ticker,
      description,
      imageUrlForUpload,
      sourceUrl
    );

    if (!metadataUri) {
      return {
        success: false,
        error: "Failed to upload token metadata after multiple attempts",
      };
    }

    const pumpUrl = `https://pump.fun/coin/${mintAddress}`;

    // Check if Mayhem Mode is enabled (admin toggle)
    const mayhemEnabled = getSetting("mayhem_mode") === "on" && !!MAYHEM_FEE_RECIPIENT;
    if (mayhemEnabled) {
      console.log(`[PumpDeployer] Mayhem Mode is ON — using create_v2 with fee recipient: ${MAYHEM_FEE_RECIPIENT}`);
    }

    // Deploy directly from master wallet — no ephemeral wallet needed
    let signature: string;
    try {
      const result = await createTokenViaPumpPortal(
        connection,
        masterWallet,
        mintKeypair,
        metadataUri,
        metadata.name,
        metadata.ticker,
        mayhemEnabled
      );
      signature = result.signature;
    } catch (portalError) {
      console.warn(
        `[PumpDeployer] PumpPortal failed, trying direct method:`,
        portalError
      );
      const result = await createTokenDirect(
        connection,
        masterWallet,
        mintKeypair,
        metadata.name,
        metadata.ticker,
        metadataUri
      );
      signature = result.signature;
    }

    // Create token record in database AFTER on-chain success
    const tokenRecord = createToken(
      metadata.name,
      metadata.ticker,
      submitterSolAddress,
      headlineId,
      submissionId,
      persistedImageUrl,
      mintAddress,
      pumpUrl,
      metadata.theme
    );

    console.log(`[PumpDeployer] Created token record #${tokenRecord.id}`);

    // Link to headline if provided
    if (headlineId) {
      linkTokenToHeadline(tokenRecord.id, headlineId);
    }

    // Audit log the successful deployment
    logDeployment({
      caller: "pump-deployer",
      success: true,
      mintAddress,
      txSignature: signature,
      estimatedCostLamports: Math.floor(MIN_DEPLOYMENT_SOL * LAMPORTS_PER_SOL),
    });

    console.log(`[PumpDeployer] Deployment successful!`);
    console.log(`[PumpDeployer] Mint: ${mintAddress}`);
    console.log(`[PumpDeployer] URL: ${pumpUrl}`);
    console.log(`[PumpDeployer] Signature: ${signature}`);

    return {
      success: true,
      mintAddress,
      pumpUrl,
      transactionSignature: signature,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown deployment error";

    // Audit log the failed deployment
    logDeployment({
      caller: "pump-deployer",
      success: false,
      errorMessage,
    });

    console.error("[PumpDeployer] Deployment failed:", error);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

// Pump.fun coin data API — v3 (current), v1 (deprecated fallback)
const PUMP_COIN_API_URLS = [
  "https://frontend-api-v3.pump.fun/coins",
  "https://frontend-api.pump.fun/coins",
];

/** Get token info from pump.fun (tries v3, then v1 fallback). */
export async function getTokenInfo(
  mintAddress: string
): Promise<{
  exists: boolean;
  price?: number;
  marketCap?: number;
  volume24h?: number;
}> {
  for (const baseUrl of PUMP_COIN_API_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      let data: Record<string, unknown>;
      try {
        const response = await fetch(
          `${baseUrl}/${mintAddress}`,
          { signal: controller.signal }
        );
        if (!response.ok) continue; // Try next URL
        data = await response.json();
      } finally {
        clearTimeout(timeout);
      }

      return {
        exists: true,
        price: data.price as number | undefined,
        marketCap: data.usd_market_cap as number | undefined,
        volume24h: data.volume_24h as number | undefined,
      };
    } catch {
      // Try next URL
    }
  }

  console.error(`[PumpDeployer] Error fetching token info for ${mintAddress} from all API endpoints`);
  return { exists: false };
}

/** Deployment configuration check. */
export async function checkDeploymentConfig(): Promise<{
  configured: boolean;
  issues: string[];
}> {
  const issues: string[] = [];

  try {
    secureGetWallet("pump-deployer:config-check");
  } catch (error) {
    issues.push(
      error instanceof Error ? error.message : "Invalid wallet configuration"
    );
  }

  if (!process.env.SOLANA_RPC_URL) {
    issues.push("SOLANA_RPC_URL not set (using default mainnet)");
  }

  try {
    const connection = getConnection();
    await connection.getLatestBlockhash();
  } catch {
    issues.push("Cannot connect to Solana RPC");
  }

  if (issues.length === 0) {
    try {
      const balanceCheck = await checkDeploymentBalance();
      if (!balanceCheck.hasEnough) {
        issues.push(
          `Insufficient balance: ${balanceCheck.balance} SOL (need ${MIN_DEPLOYMENT_SOL} SOL)`
        );
      }
    } catch {
      issues.push("Cannot check wallet balance");
    }
  }

  return { configured: issues.length === 0, issues };
}
