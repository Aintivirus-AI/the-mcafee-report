import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getPrivateKeySync } from "./secrets-provider";

// Configuration
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// Connection instance (singleton)
let connectionInstance: Connection | null = null;

/**
 * Get Solana connection (singleton pattern)
 */
export function getConnection(): Connection {
  if (!connectionInstance) {
    connectionInstance = new Connection(SOLANA_RPC_URL, {
      commitment: "confirmed",
      confirmTransactionInitialTimeout: 60000,
    });
  }
  return connectionInstance;
}

/**
 * Get the master wallet keypair.
 *
 * Retrieves the private key from the configured secrets provider
 * (AWS Secrets Manager, encrypted env var, or plain env var depending
 * on WALLET_SECRET_PROVIDER). The secrets provider handles caching internally.
 *
 * For AWS mode, `initializeKey()` from secrets-provider must be called
 * once at startup before this function is used.
 */
export function getMasterWallet(): Keypair {
  const base58Key = getPrivateKeySync();

  try {
    const secretKey = bs58.decode(base58Key);
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    throw new Error("Invalid private key format from secrets provider. Must be base58 encoded.");
  }
}

/**
 * Get the master wallet public key as string
 */
export function getMasterWalletAddress(): string {
  return getMasterWallet().publicKey.toBase58();
}

/**
 * Check master wallet balance
 */
export async function getMasterWalletBalance(): Promise<{ lamports: number; sol: number }> {
  const connection = getConnection();
  const wallet = getMasterWallet();
  
  const balance = await connection.getBalance(wallet.publicKey);
  
  return {
    lamports: balance,
    sol: balance / LAMPORTS_PER_SOL,
  };
}

/**
 * Validate a Solana address
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send SOL from master wallet to a recipient
 */
export async function sendSol(
  recipientAddress: string,
  lamports: number,
  options: { maxRetries?: number; skipPreflight?: boolean } = {}
): Promise<{ success: boolean; signature?: string; error?: string }> {
  const { maxRetries = 3, skipPreflight = false } = options;
  
  console.log(`[Wallet] Sending ${lamports / LAMPORTS_PER_SOL} SOL to ${recipientAddress}`);
  
  if (!isValidSolanaAddress(recipientAddress)) {
    return { success: false, error: "Invalid recipient address" };
  }
  
  const connection = getConnection();
  const masterWallet = getMasterWallet();
  const recipient = new PublicKey(recipientAddress);
  
  // Pre-flight balance check (informational only — the chain enforces this atomically).
  // We do NOT rely on this check for correctness because of TOCTOU race conditions:
  // two concurrent sendSol calls could both pass this check and then one fails on-chain.
  const balance = await getMasterWalletBalance();
  const estimatedFee = 10_000; // ~0.00001 SOL (conservative estimate for priority fees)
  if (balance.lamports < lamports + estimatedFee) {
    return { 
      success: false, 
      error: `Insufficient balance: ${balance.sol} SOL, need ${(lamports + estimatedFee) / LAMPORTS_PER_SOL} SOL` 
    };
  }
  
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Create transfer instruction
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: masterWallet.publicKey,
          toPubkey: recipient,
          lamports,
        })
      );
      
      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = masterWallet.publicKey;

      // Sign and send (manual send + polling confirmation to avoid WebSocket)
      transaction.sign(masterWallet);
      const signature = await connection.sendRawTransaction(
        transaction.serialize(),
        {
          skipPreflight,
          preflightCommitment: "confirmed",
        }
      );

      await confirmTransactionPolling(
        connection,
        signature,
        blockhash,
        lastValidBlockHeight,
        "confirmed"
      );

      console.log(`[Wallet] Transfer successful: ${signature}`);
      
      return { success: true, signature };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[Wallet] Transfer attempt ${attempt} failed:`, lastError.message);
      
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  
  return { 
    success: false, 
    error: lastError?.message || "Transfer failed after all retries" 
  };
}

/**
 * Get recent transactions for the master wallet
 */
export async function getRecentTransactions(limit: number = 10): Promise<Array<{
  signature: string;
  timestamp: number | null | undefined;
  slot: number;
  err: any;
}>> {
  const connection = getConnection();
  const wallet = getMasterWallet();
  
  const signatures = await connection.getSignaturesForAddress(
    wallet.publicKey,
    { limit }
  );
  
  return signatures.map(sig => ({
    signature: sig.signature,
    timestamp: sig.blockTime,
    slot: sig.slot,
    err: sig.err,
  }));
}

/**
 * Monitor wallet for incoming transactions
 * Returns a function to stop monitoring
 */
export function monitorWalletForIncoming(
  onTransaction: (signature: string, lamports: number) => void
): () => void {
  const connection = getConnection();
  const wallet = getMasterWallet();
  
  let subscriptionId: number | null = null;
  
  // Subscribe to account changes
  subscriptionId = connection.onAccountChange(
    wallet.publicKey,
    async (accountInfo, context) => {
      try {
        console.log(`[Wallet] Account change detected in slot ${context.slot}`);

        // Get recent transactions to find the incoming one
        const signatures = await connection.getSignaturesForAddress(
          wallet.publicKey,
          { limit: 1 }
        );

        if (signatures.length > 0) {
          const sig = signatures[0];
          // Get transaction details to find the amount
          const tx = await connection.getTransaction(sig.signature, {
            commitment: "confirmed",
          });

          if (tx && tx.meta) {
            const preBalance = tx.meta.preBalances[0];
            const postBalance = tx.meta.postBalances[0];
            const lamportsDiff = postBalance - preBalance;

            if (lamportsDiff > 0) {
              onTransaction(sig.signature, lamportsDiff);
            }
          }
        }
      } catch (error) {
        console.error("[Wallet] Error processing incoming transaction:", error);
      }
    },
    "confirmed"
  );
  
  console.log(`[Wallet] Started monitoring wallet ${wallet.publicKey.toBase58()}`);
  
  // Return unsubscribe function
  return () => {
    if (subscriptionId !== null) {
      connection.removeAccountChangeListener(subscriptionId);
      console.log("[Wallet] Stopped monitoring wallet");
    }
  };
}

// generateNewWallet() removed — returning private keys as plain strings
// is a security risk (they end up in logs, HTTP responses, error reports).
// Use Solana CLI or a secure key management solution instead.

/**
 * Confirm a transaction using polling (getSignatureStatuses) instead of
 * WebSocket subscriptions.  The default public RPC does not support the
 * `signatureSubscribe` WebSocket method, so the deprecated
 * `confirmTransaction(sig, commitment)` overload will fail.
 *
 * This helper polls every 2 seconds until either:
 *   - the signature reaches the desired commitment level, or
 *   - the blockhash expires (lastValidBlockHeight exceeded), or
 *   - maxRetries polling attempts are exhausted.
 */
export async function confirmTransactionPolling(
  connection: Connection,
  signature: string,
  blockhash: string,
  lastValidBlockHeight: number,
  commitment: "confirmed" | "finalized" = "confirmed",
  pollIntervalMs: number = 2000,
  maxRetries: number = 60
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const { value: statuses } = await connection.getSignatureStatuses([
      signature,
    ]);
    const status = statuses?.[0];

    if (status) {
      if (status.err) {
        throw new Error(
          `Transaction ${signature} failed: ${JSON.stringify(status.err)}`
        );
      }
      // "finalized" satisfies both "confirmed" and "finalized"
      if (
        status.confirmationStatus === commitment ||
        status.confirmationStatus === "finalized"
      ) {
        return;
      }
    }

    // Check if blockhash has expired
    const blockHeight = await connection.getBlockHeight();
    if (blockHeight > lastValidBlockHeight) {
      throw new Error(
        `Transaction ${signature} expired: block height ${blockHeight} > ${lastValidBlockHeight}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `Transaction ${signature} confirmation timed out after ${maxRetries} polls`
  );
}

/**
 * Check wallet configuration
 */
export async function checkWalletConfig(): Promise<{
  configured: boolean;
  address?: string;
  balance?: number;
  issues: string[];
}> {
  const issues: string[] = [];
  
  try {
    const wallet = getMasterWallet();
    const address = wallet.publicKey.toBase58();
    
    // Check connection
    const connection = getConnection();
    const balance = await connection.getBalance(wallet.publicKey);
    const balanceSol = balance / LAMPORTS_PER_SOL;
    
    if (balanceSol < 0.01) {
      issues.push(`Low balance: ${balanceSol} SOL`);
    }
    
    return {
      configured: issues.length === 0,
      address,
      balance: balanceSol,
      issues,
    };
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "Unknown error");
    return { configured: false, issues };
  }
}
