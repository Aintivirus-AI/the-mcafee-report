/**
 * WAGMI/NGMI Community Voting API.
 *
 * POST: Cast a vote (wagmi or ngmi) for a headline.
 * GET:  Retrieve vote counts for a headline, or global sentiment.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { castVote, getVoteCounts, getGlobalSentiment, hasVoted } from "@/lib/db";
import { ActivityLog } from "@/lib/activity-logger";

// Rate limiting for vote POST
const VOTE_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const VOTE_RATE_LIMIT_MAX = 30; // 30 votes per minute per IP
const voteRateLimitMap = new Map<string, { count: number; windowStart: number }>();

function checkVoteRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = voteRateLimitMap.get(key);
  if (!entry || now - entry.windowStart > VOTE_RATE_LIMIT_WINDOW_MS) {
    voteRateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= VOTE_RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// Periodically clean up stale vote rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of voteRateLimitMap) {
    if (now - entry.windowStart > VOTE_RATE_LIMIT_WINDOW_MS * 2) {
      voteRateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Create a voter hash from multiple signals for dedup without storing PII.
 * Uses IP + User-Agent + Accept-Language + a server-side salt to make
 * the hash resistant to spoofing any single header.
 */
const VOTER_HASH_SALT = process.env.VOTER_HASH_SALT || process.env.API_SECRET_KEY || "default-voter-salt";

function getVoterHash(request: NextRequest): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  const ua = request.headers.get("user-agent") || "unknown";
  const lang = request.headers.get("accept-language") || "unknown";
  const encoding = request.headers.get("accept-encoding") || "unknown";
  return crypto
    .createHash("sha256")
    .update(`${VOTER_HASH_SALT}:${ip}:${ua}:${lang}:${encoding}`)
    .digest("hex");
}

function getVoterIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * GET /api/votes?headline_id=123      → vote counts for a headline
 * GET /api/votes?aggregate=true        → global sentiment
 * GET /api/votes?headline_id=123&check=true → check if voter already voted
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Global sentiment
    if (searchParams.get("aggregate") === "true") {
      const sentiment = getGlobalSentiment();
      return NextResponse.json(sentiment);
    }

    const headlineIdStr = searchParams.get("headline_id");
    if (!headlineIdStr) {
      return NextResponse.json(
        { error: "headline_id is required" },
        { status: 400 }
      );
    }

    const headlineId = parseInt(headlineIdStr, 10);
    if (isNaN(headlineId)) {
      return NextResponse.json(
        { error: "Invalid headline_id" },
        { status: 400 }
      );
    }

    const counts = getVoteCounts(headlineId);

    // Optionally check if the current voter has already voted
    if (searchParams.get("check") === "true") {
      const voterHash = getVoterHash(request);
      const existingVote = hasVoted(headlineId, voterHash);
      return NextResponse.json({ ...counts, voted: existingVote });
    }

    return NextResponse.json(counts);
  } catch (error) {
    console.error("[API /votes] GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/votes
 * Body: { headline_id: number, vote_type: "wagmi" | "ngmi" }
 */
export async function POST(request: NextRequest) {
  try {
    // Rate limit votes by IP
    const voterIp = getVoterIp(request);
    if (!checkVoteRateLimit(voterIp)) {
      return NextResponse.json(
        { error: "Too many votes. Please slow down." },
        { status: 429 }
      );
    }

    const body = await request.json();
    const { headline_id, vote_type } = body;

    if (headline_id == null || vote_type == null || typeof vote_type !== "string") {
      return NextResponse.json(
        { error: "headline_id and vote_type are required" },
        { status: 400 }
      );
    }

    if (vote_type !== "wagmi" && vote_type !== "ngmi") {
      return NextResponse.json(
        { error: "vote_type must be 'wagmi' or 'ngmi'" },
        { status: 400 }
      );
    }

    const headlineId = parseInt(headline_id, 10);
    if (isNaN(headlineId)) {
      return NextResponse.json(
        { error: "Invalid headline_id" },
        { status: 400 }
      );
    }

    const voterHash = getVoterHash(request);
    const success = castVote(headlineId, vote_type, voterHash);

    if (!success) {
      // Already voted — return current counts anyway
      const counts = getVoteCounts(headlineId);
      return NextResponse.json({
        ...counts,
        voted: vote_type,
        already_voted: true,
      });
    }

    // Log the vote to the activity feed
    ActivityLog.voteCast(headlineId, vote_type);

    const counts = getVoteCounts(headlineId);
    return NextResponse.json({
      ...counts,
      voted: vote_type,
      already_voted: false,
    });
  } catch (error) {
    console.error("[API /votes] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
