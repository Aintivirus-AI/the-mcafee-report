import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { safeCompare } from "@/lib/auth";

const API_KEY = process.env.SCHEDULER_API_KEY || process.env.API_KEY || "";

function isAuthorized(request: NextRequest): boolean {
  if (!API_KEY) return false;
  const key = request.headers.get("x-api-key");
  return !!key && safeCompare(key, API_KEY);
}

/**
 * GET /api/admin/mayhem
 * Returns the current mayhem mode status (requires API key auth).
 */
export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const value = getSetting("mayhem_mode");
  return NextResponse.json({
    enabled: value === "on",
  });
}

/**
 * POST /api/admin/mayhem
 * Body: { enabled: true|false }
 * Requires API key auth.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const enabled = Boolean(body.enabled);
    setSetting("mayhem_mode", enabled ? "on" : "off");

    console.log(`[Admin] Mayhem mode ${enabled ? "ENABLED" : "DISABLED"}`);

    return NextResponse.json({ enabled, message: `Mayhem mode ${enabled ? "enabled" : "disabled"}` });
  } catch (error) {
    console.error("[Admin] Mayhem toggle error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
