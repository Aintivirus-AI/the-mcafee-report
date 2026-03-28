/**
 * War Room API - Live activity feed and stats.
 *
 * GET /api/war-room               → latest 50 events + stats
 * GET /api/war-room?after=<id>    → events after a specific ID (for polling)
 */

import { NextRequest, NextResponse } from "next/server";
import { getActivityLog, getActivityStats } from "@/lib/db";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const afterIdStr = searchParams.get("after");
    const limitStr = searchParams.get("limit");

    const limit = Math.min(parseInt(limitStr || "50", 10) || 50, 100);
    let afterId: number | undefined;
    if (afterIdStr !== null) {
      const parsed = parseInt(afterIdStr, 10);
      if (isNaN(parsed) || parsed <= 0 || parsed > 2147483647) {
        return NextResponse.json({ error: "Invalid after parameter" }, { status: 400 });
      }
      afterId = parsed;
    }

    const events = getActivityLog(limit, afterId);
    const stats = getActivityStats();

    return NextResponse.json({
      events,
      stats,
    });
  } catch (error) {
    console.error("[API /war-room] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
