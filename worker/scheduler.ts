/**
 * Scheduler worker process.
 *
 * Fixed 10-minute cadence:
 * - Publishes 1 approved article every 10 minutes (6/hour, 144/day)
 * - Validates up to 10 pending submissions per cycle
 * - Revenue processing runs on a fixed 5-minute cron (independent)
 *
 * Other features:
 * - Graceful shutdown waits for in-progress work
 * - Uncaught exception / unhandled rejection handlers
 * - Dynamic imports so dotenv loads before app modules
 */

import { config } from "dotenv";
import path from "path";
import cron, { ScheduledTask } from "node-cron";

// Load environment variables BEFORE any app modules
const envPaths = [
  path.join(process.cwd(), ".env.local"),
  path.join(__dirname, "..", ".env.local"),
  ".env.local",
];

let envLoaded = false;
for (const envPath of envPaths) {
  const result = config({ path: envPath });
  if (!result.error) {
    envLoaded = true;
    console.log(`✅ Loaded environment from: ${envPath}`);
    break;
  }
}

if (!envLoaded) {
  console.warn("⚠️  Could not load .env.local, trying default .env");
  config();
}

// Track concurrent execution
let isRunning = false;
let isProcessingRevenue = false;
let isClaimingFees = false;
let cycleCount = 0;
let isShuttingDown = false;

// Store cron tasks for cleanup
const cronTasks: ScheduledTask[] = [];

// Dynamically imported module references (loaded in main after env is ready)
let runSchedulerCycle: typeof import("../lib/scheduler")["runSchedulerCycle"];
let getSchedulerStatus: typeof import("../lib/scheduler")["getSchedulerStatus"];
let processPendingRevenue: typeof import("../lib/revenue-distributor")["processPendingRevenue"];
let claimAllCreatorFees: typeof import("../lib/creator-fee-claimer")["claimAllCreatorFees"];

/**
 * Run a scheduler cycle (called every 10 minutes by cron).
 */
async function safeRunCycle(): Promise<void> {
  if (isRunning || isShuttingDown) {
    console.log("[Worker] Scheduler cycle already running or shutting down, skipping...");
    return;
  }

  isRunning = true;
  cycleCount++;

  console.log(`\n${"=".repeat(50)}`);
  console.log(
    `[Worker] Starting cycle #${cycleCount} at ${new Date().toISOString()}`
  );
  console.log(`${"=".repeat(50)}\n`);

  try {
    const result = await runSchedulerCycle();

    if (result.published.length > 0) {
      console.log(
        `[Worker] Published ${result.published.length} submission(s): ` +
        result.published.map(s => `#${s.id}`).join(", ")
      );
    }
  } catch (error) {
    console.error("[Worker] Error during scheduler cycle:", error);
  } finally {
    isRunning = false;
  }
}

/**
 * Process pending revenue events with safety checks.
 */
async function safeProcessRevenue(): Promise<void> {
  if (isProcessingRevenue || isShuttingDown) {
    console.log("[Worker] Revenue processing already running or shutting down, skipping...");
    return;
  }

  isProcessingRevenue = true;
  try {
    const result = await processPendingRevenue();
    if (result.processed > 0 || result.failed > 0) {
      console.log(
        `[Worker] Revenue: ${result.processed} processed, ${result.failed} failed`
      );
    }
  } catch (error) {
    console.error("[Worker] Revenue processing error:", error);
  } finally {
    isProcessingRevenue = false;
  }
}

/**
 * Claim creator fees from the master wallet (and any legacy ephemeral wallets).
 * Runs every 30 minutes via cron.
 */
async function safeClaimCreatorFees(): Promise<void> {
  if (isClaimingFees || isShuttingDown) {
    console.log("[Worker] Fee claiming already running or shutting down, skipping...");
    return;
  }

  isClaimingFees = true;
  try {
    const result = await claimAllCreatorFees();
    if (result.claimed > 0 || result.failed > 0) {
      console.log(
        `[Worker] Fee claims: ${result.claimed} claimed, ${result.failed} failed, ` +
        `${result.totalClaimedLamports / 1e9} SOL total`
      );
    }
  } catch (error) {
    console.error("[Worker] Fee claiming error:", error);
  } finally {
    isClaimingFees = false;
  }
}

// Main function
async function main(): Promise<void> {
  // Dynamic imports: app modules are loaded HERE, after dotenv has run.
  const scheduler = await import("../lib/scheduler");
  const revenue = await import("../lib/revenue-distributor");
  const feeClaimer = await import("../lib/creator-fee-claimer");

  runSchedulerCycle = scheduler.runSchedulerCycle;
  getSchedulerStatus = scheduler.getSchedulerStatus;
  processPendingRevenue = revenue.processPendingRevenue;
  claimAllCreatorFees = feeClaimer.claimAllCreatorFees;

  console.log("🚀 Starting News Token Scheduler Worker");
  console.log(`📊 Initial status: ${JSON.stringify(getSchedulerStatus())}`);

  // Run all jobs immediately on startup (don't wait for first cron tick)
  await safeRunCycle();
  safeProcessRevenue().catch((err) => console.error("[Worker] startup revenue task failed:", err));
  safeClaimCreatorFees().catch((err) => console.error("[Worker] startup fee-claim task failed:", err));

  // Fixed 10-minute publishing cycle: 1 article per cycle = 6/hour, 144/day
  const publishingTask = cron.schedule("*/10 * * * *", async () => {
    await safeRunCycle();
  });
  cronTasks.push(publishingTask);

  // Revenue processing stays on a fixed 5-minute cron (independent of publishing)
  const revenueTask = cron.schedule("*/5 * * * *", async () => {
    await safeProcessRevenue();
  });
  cronTasks.push(revenueTask);

  // Creator fee claiming from master wallet (every 30 minutes)
  const feeClaimTask = cron.schedule("*/30 * * * *", async () => {
    await safeClaimCreatorFees();
  });
  cronTasks.push(feeClaimTask);

  console.log("⏰ Scheduler started:");
  console.log("   - Publishing:  every 10 minutes (6/hour, 144/day)");
  console.log("   - Revenue:     every 5 minutes");
  console.log("   - Fee claims:  every 30 minutes");
  console.log("   Press Ctrl+C to stop\n");

  // Graceful shutdown — waits for in-progress work to complete
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n👋 Received ${signal}, shutting down scheduler...`);

    // Stop cron jobs from scheduling new work
    for (const task of cronTasks) {
      task.stop();
    }

    // Wait for in-progress work (max 30 seconds)
    const maxWaitMs = 30_000;
    const startWait = Date.now();
    while ((isRunning || isProcessingRevenue || isClaimingFees) && Date.now() - startWait < maxWaitMs) {
      console.log("[Worker] Waiting for in-progress work to complete...");
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (isRunning || isProcessingRevenue || isClaimingFees) {
      console.warn("[Worker] Timed out waiting for in-progress work — exiting anyway");
    }

    console.log("[Worker] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Catch unhandled errors — trigger shutdown to clean up timers and in-progress work
  process.on("uncaughtException", (error) => {
    console.error("[Worker] Uncaught exception — initiating shutdown:", error);
    shutdown("uncaughtException").catch(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[Worker] Unhandled rejection — initiating shutdown:", reason);
    shutdown("unhandledRejection").catch(() => process.exit(1));
  });
}

// Start the worker
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
