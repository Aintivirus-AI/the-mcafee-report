/**
 * Text-to-Speech API using ElevenLabs.
 *
 * POST: Generate speech audio from text using the McAfee cloned voice.
 * Returns audio/mpeg stream.
 *
 * SECURITY: Rate-limited per IP to prevent cost abuse.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_MCAFEE_VOICE_ID;

// Simple in-memory cache to avoid re-generating the same text
const audioCache = new Map<string, { buffer: ArrayBuffer; timestamp: number }>();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (reduced from 24h to limit memory pressure from large ArrayBuffers)
const MAX_CACHE_ENTRIES = 25; // ~25 entries × ~1MB each ≈ 25MB max

// Rate limiting: max requests per IP per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 5; // 5 TTS requests per minute per IP
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function getRateLimitKey(request: NextRequest): string {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  return ip;
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  entry.count++;
  return true;
}

// Periodically clean up stale rate limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Periodically prune expired audio cache entries to reclaim memory from large ArrayBuffers
setInterval(() => {
  pruneCache();
}, 10 * 60 * 1000);

function getCacheKey(text: string): string {
  // Use SHA-256 for collision-resistant cache keys
  return `tts_${crypto.createHash("sha256").update(text).digest("hex").substring(0, 16)}`;
}

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of audioCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      audioCache.delete(key);
    }
  }
  // If still over limit, remove oldest entries
  if (audioCache.size > MAX_CACHE_ENTRIES) {
    const sorted = [...audioCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = sorted.slice(0, audioCache.size - MAX_CACHE_ENTRIES);
    for (const [key] of toRemove) {
      audioCache.delete(key);
    }
  }
  // Alert on high heap usage to catch memory pressure from large ArrayBuffers
  const { heapUsed, heapTotal } = process.memoryUsage();
  if (heapUsed / heapTotal > 0.85) {
    console.warn(
      `[API /tts] High heap usage: ${Math.round(heapUsed / 1024 / 1024)}MB / ${Math.round(heapTotal / 1024 / 1024)}MB`
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Rate limit check
    const rateLimitKey = getRateLimitKey(request);
    if (!checkRateLimit(rateLimitKey)) {
      return NextResponse.json(
        { error: "Rate limit exceeded. Please try again in a minute." },
        { status: 429 }
      );
    }

    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      return NextResponse.json(
        { error: "TTS service not configured" },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { text } = body;

    if (!text || typeof text !== "string") {
      return NextResponse.json(
        { error: "text is required" },
        { status: 400 }
      );
    }

    // ElevenLabs has a 5000 character limit per request
    if (text.length > 5000) {
      return NextResponse.json(
        { error: "Text too long (max 5000 characters)" },
        { status: 400 }
      );
    }

    // Check cache first
    const cacheKey = getCacheKey(text);
    const cached = audioCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return new NextResponse(cached.buffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    // Call ElevenLabs API
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.85,
            style: 0.6,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error("[API /tts] ElevenLabs error:", response.status, errorText);
      return NextResponse.json(
        { error: "TTS generation failed" },
        { status: 502 }
      );
    }

    const audioBuffer = await response.arrayBuffer();

    // Cache the result
    pruneCache();
    audioCache.set(cacheKey, { buffer: audioBuffer, timestamp: Date.now() });

    return new NextResponse(audioBuffer, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (error) {
    console.error("[API /tts] POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
