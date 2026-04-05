import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getComments, addComment } from "@/lib/db";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

/**
 * Validate Telegram Login Widget auth data.
 * https://core.telegram.org/widgets/login#checking-authorization
 */
function validateTelegramAuth(data: Record<string, string>): boolean {
  if (!BOT_TOKEN) return false;

  const { hash, ...rest } = data;
  if (!hash) return false;

  // Check auth_date is not too old (allow 1 day)
  const authDate = parseInt(rest.auth_date || "0", 10);
  if (Date.now() / 1000 - authDate > 86400) return false;

  // Build check string: sorted key=value pairs joined by \n
  const checkString = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const hmac = crypto
    .createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  return hmac === hash;
}

/**
 * GET /api/comments?headline_id=X
 */
export async function GET(request: NextRequest) {
  const headlineId = request.nextUrl.searchParams.get("headline_id");
  if (!headlineId) {
    return NextResponse.json({ error: "headline_id required" }, { status: 400 });
  }

  const comments = getComments(parseInt(headlineId, 10));
  return NextResponse.json({ comments });
}

/**
 * POST /api/comments
 * Body: { headline_id, content, auth: { id, first_name, username, auth_date, hash, ... } }
 */
export async function POST(request: NextRequest) {
  try {
    // Reject oversized payloads before parsing to prevent memory exhaustion
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 1_000_000) {
      return NextResponse.json({ error: "Request too large" }, { status: 413 });
    }

    const body = await request.json();
    const { headline_id, content, auth } = body;

    if (!headline_id || !content || !auth) {
      return NextResponse.json(
        { error: "headline_id, content, and auth are required" },
        { status: 400 }
      );
    }

    if (typeof content !== "string" || content.trim().length === 0) {
      return NextResponse.json({ error: "Comment cannot be empty" }, { status: 400 });
    }

    if (content.trim().length > 1000) {
      return NextResponse.json({ error: "Comment too long (max 1000 chars)" }, { status: 400 });
    }

    // Validate Telegram auth
    const authData: Record<string, string> = {};
    for (const [k, v] of Object.entries(auth)) {
      authData[k] = String(v);
    }

    if (!validateTelegramAuth(authData)) {
      return NextResponse.json({ error: "Invalid authentication" }, { status: 401 });
    }

    const comment = addComment(
      parseInt(headline_id, 10),
      authData.id,
      content.trim(),
      authData.username,
      authData.first_name
    );

    return NextResponse.json({ comment }, { status: 201 });
  } catch (error) {
    console.error("[Comments API] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
