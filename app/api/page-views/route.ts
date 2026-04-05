/**
 * Page View Tracking API.
 *
 * POST: Record a page view (public, rate-limited).
 * GET:  Retrieve visit statistics (admin-only via x-api-key).
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { recordPageView, getVisitStats } from "@/lib/db";
import { safeCompare } from "@/lib/auth";

// Rate limiting per IP
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 page views per minute per IP
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// Clean up stale rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Use a dedicated salt for visitor hashing — must not fall back to API_SECRET_KEY
// to preserve key separation between authentication and deduplication hashing.
const HASH_SALT = process.env.VISITOR_HASH_SALT || "default-pageview-salt";

function getVisitorHash(request: NextRequest): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const ua = request.headers.get("user-agent") || "unknown";
  const lang = request.headers.get("accept-language") || "unknown";
  return crypto
    .createHash("sha256")
    .update(`${HASH_SALT}:${ip}:${ua}:${lang}`)
    .digest("hex");
}

function getVisitorIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * POST /api/page-views
 * Body: { path: string }
 */
export async function POST(request: NextRequest) {
  try {
    const ip = getVisitorIp(request);
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: "Rate limited" },
        { status: 429 }
      );
    }

    const body = await request.json();
    const pagePath = body.path;

    if (!pagePath || typeof pagePath !== "string") {
      return NextResponse.json(
        { error: "path is required" },
        { status: 400 }
      );
    }

    // Sanitize: only allow reasonable path lengths
    const sanitizedPath = pagePath.slice(0, 500);

    const visitorHash = getVisitorHash(request);
    const isNew = recordPageView(sanitizedPath, visitorHash);

    return NextResponse.json({ recorded: isNew });
  } catch (error) {
    console.error("[API /page-views] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/page-views
 * Admin-only: requires x-api-key header.
 */
export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get("x-api-key");
    const expectedKey = process.env.API_SECRET_KEY;

    if (!apiKey || !expectedKey || !safeCompare(apiKey, expectedKey)) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const stats = getVisitStats();
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API /page-views] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
