import { NextRequest, NextResponse } from "next/server";
import {
  runSchedulerCycle,
  processValidationQueue,
  publishApprovedBatch,
  getSchedulerStatus,
} from "@/lib/scheduler";
import { claimAllCreatorFees } from "@/lib/creator-fee-claimer";
import { resetFeeClaimTimestamps } from "@/lib/db";
import { isAuthenticated } from "@/lib/auth";

// Debounce: track last validation trigger time to prevent rapid-fire calls.
// If multiple users submit within 30 seconds, only the first triggers
// immediate validation — the rest are batched in that same cycle.
const DEBOUNCE_MS = 30_000;
let lastValidateTriggerMs = 0;

/**
 * POST /api/scheduler/trigger
 *
 * Trigger a scheduler action. Called automatically by the bot on each
 * submission (event-driven) and can also be triggered manually.
 *
 * Query params / JSON body:
 *   action: "cycle" (default) | "validate" | "publish" | "claim-fees" | "reset-fee-timers" | "status"
 *
 * Auth: x-api-key header ONLY (query param auth removed — keys in URLs leak in logs)
 *
 * Examples:
 *   curl -X POST -H "x-api-key: YOUR_SECRET" "http://localhost:3000/api/scheduler/trigger"
 *   curl -X POST -H "x-api-key: YOUR_SECRET" "http://localhost:3000/api/scheduler/trigger?action=validate"
 */
export async function POST(request: NextRequest) {
  if (!isAuthenticated(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Defense-in-depth: reject browser-originated cross-origin requests
  const origin = request.headers.get("origin");
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (origin && siteUrl && origin !== siteUrl) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Accept action from query param or JSON body
  let action = request.nextUrl.searchParams.get("action") || "cycle";

  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const body = await request.json().catch(() => ({}));
      if (body.action) action = body.action;
    }
  } catch {
    // Ignore parse errors, use query param
  }

  try {
    switch (action) {
      case "validate": {
        // Debounce: skip if triggered recently (another cycle is already running)
        const now = Date.now();
        if (now - lastValidateTriggerMs < DEBOUNCE_MS) {
          console.log(
            `[API] Validate trigger debounced (${Math.round((now - lastValidateTriggerMs) / 1000)}s since last)`
          );
          const status = getSchedulerStatus();
          return NextResponse.json({
            success: true,
            action: "validate",
            message: "Validation already triggered recently, will be processed in current cycle",
            debounced: true,
            status,
          });
        }

        lastValidateTriggerMs = now;
        console.log("[API] Trigger: validate");
        await processValidationQueue();
        const status = getSchedulerStatus();
        return NextResponse.json({
          success: true,
          action: "validate",
          message: "Validation queue processed",
          status,
        });
      }

      case "publish": {
        console.log("[API] Manual trigger: publish batch");
        const published = await publishApprovedBatch();
        const status = getSchedulerStatus();
        return NextResponse.json({
          success: true,
          action: "publish",
          message: published.length > 0
            ? `Published ${published.length} submission(s): ${published.map(s => `#${s.id}`).join(", ")}`
            : "No approved submissions to publish",
          published: published.map(s => ({ id: s.id, url: s.url, status: s.status })),
          status,
        });
      }

      case "claim-fees": {
        console.log("[API] Manual trigger: claim creator fees");
        const claimResult = await claimAllCreatorFees();
        const claimStatus = getSchedulerStatus();
        return NextResponse.json({
          success: true,
          action: "claim-fees",
          message: claimResult.claimed > 0
            ? `Claimed fees from ${claimResult.claimed} token(s), ${(claimResult.totalClaimedLamports / 1e9).toFixed(6)} SOL total`
            : `Processed ${claimResult.processed} token(s), no fees to claim`,
          processed: claimResult.processed,
          claimed: claimResult.claimed,
          failed: claimResult.failed,
          totalClaimedSol: claimResult.totalClaimedLamports / 1e9,
          results: claimResult.results,
          status: claimStatus,
        });
      }

      case "reset-fee-timers": {
        console.log("[API] Manual trigger: reset fee claim timestamps");
        const resetCount = resetFeeClaimTimestamps();
        return NextResponse.json({
          success: true,
          action: "reset-fee-timers",
          message: `Reset ${resetCount} token(s) — all now eligible for fee claiming`,
          tokensReset: resetCount,
        });
      }

      case "status": {
        const status = getSchedulerStatus();
        return NextResponse.json({
          success: true,
          action: "status",
          status,
        });
      }

      case "cycle":
      default: {
        console.log("[API] Manual trigger: full cycle");
        const result = await runSchedulerCycle();
        const status = getSchedulerStatus();
        return NextResponse.json({
          success: true,
          action: "cycle",
          message: result.published.length > 0
            ? `Cycle complete – published ${result.published.length}: ${result.published.map(s => `#${s.id}`).join(", ")}`
            : "Cycle complete – nothing to publish",
          validated: result.validated,
          published: result.published.map(s => ({ id: s.id, url: s.url, status: s.status })),
          status,
        });
      }
    }
  } catch (error) {
    console.error("[API] Scheduler trigger error:", error);
    // SECURITY: Don't leak error details (internal paths, schema info, etc.)
    return NextResponse.json(
      {
        success: false,
        error: "Scheduler trigger failed",
      },
      { status: 500 }
    );
  }
}

// SECURITY: Removed GET handler — state-changing operations must use POST only.
// GET requests are cacheable, pre-fetchable, and vulnerable to CSRF via <img> tags.
