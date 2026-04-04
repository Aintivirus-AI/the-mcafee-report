import { NextRequest, NextResponse } from "next/server";
import { getAllTokens } from "@/lib/db";
import { isValidBase58Address } from "@/lib/auth";

// Cache configuration
const CACHE_TTL_MS = 30 * 1000; // 30 seconds
const MAX_CACHE_SIZE = 500; // Prevent unbounded growth

interface CachedPrice {
  price: number;
  priceChange24h: number;
  marketCap?: number;
  volume24h?: number;
  lastUpdated: number;
}

interface TokenPriceResponse {
  mintAddress: string;
  ticker: string;
  price: number;
  priceChange24h: number;
  marketCap?: number;
  volume24h?: number;
  imageUrl?: string;
  pumpUrl?: string;
}

// LRU-like cache with size limit and TTL eviction
let priceCache: Map<string, CachedPrice> = new Map();

/** Evict expired entries and oldest if over limit */
function evictCache() {
  const now = Date.now();

  // Remove expired entries
  for (const [key, value] of priceCache) {
    if (now - value.lastUpdated > CACHE_TTL_MS) {
      priceCache.delete(key);
    }
  }

  // If still over limit, remove oldest entries
  if (priceCache.size > MAX_CACHE_SIZE) {
    const entries = [...priceCache.entries()].sort(
      (a, b) => a[1].lastUpdated - b[1].lastUpdated
    );
    const toRemove = entries.slice(0, priceCache.size - MAX_CACHE_SIZE);
    for (const [key] of toRemove) {
      priceCache.delete(key);
    }
  }
}

// Rate limiting: simple sliding window per IP
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // 30 requests per minute

function isRateLimited(request: NextRequest): boolean {
  const rawIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = (rawIp && rawIp.length > 0) ? rawIp : "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return true;

  return false;
}

// Periodically clean up stale rate limit entries to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Fetch price data from pump.fun API
 */
async function fetchPumpFunPrice(mintAddress: string): Promise<CachedPrice | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(
        `https://frontend-api.pump.fun/coins/${mintAddress}`,
        {
          headers: {
            "Accept": "application/json",
          },
          signal: controller.signal,
          next: { revalidate: 30 },
        }
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      
      return {
        price: data.price || 0,
        priceChange24h: data.price_change_24h || 0,
        marketCap: data.usd_market_cap,
        volume24h: data.volume_24h,
        lastUpdated: Date.now(),
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.error(`Error fetching pump.fun price for ${mintAddress}:`, error);
    return null;
  }
}

/**
 * Fetch price data from DexScreener as fallback
 */
async function fetchDexScreenerPrice(mintAddress: string): Promise<CachedPrice | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
        {
          headers: {
            "Accept": "application/json",
          },
          signal: controller.signal,
          next: { revalidate: 30 },
        }
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const pair = data.pairs?.[0]; // Get the first/main pair

      if (!pair) {
        return null;
      }

      return {
        price: parseFloat(pair.priceUsd) || 0,
        priceChange24h: pair.priceChange?.h24 || 0,
        marketCap: pair.fdv,
        volume24h: pair.volume?.h24,
        lastUpdated: Date.now(),
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    console.error(`Error fetching DexScreener price for ${mintAddress}:`, error);
    return null;
  }
}

/**
 * Get price for a single token with caching
 */
async function getTokenPrice(mintAddress: string): Promise<CachedPrice | null> {
  // Check cache first
  const cached = priceCache.get(mintAddress);
  if (cached && Date.now() - cached.lastUpdated < CACHE_TTL_MS) {
    return cached;
  }

  // Try pump.fun first, then DexScreener as fallback
  let price = await fetchPumpFunPrice(mintAddress);
  
  if (!price) {
    price = await fetchDexScreenerPrice(mintAddress);
  }

  if (price) {
    priceCache.set(mintAddress, price);
    evictCache();
  }

  return price;
}

/**
 * GET /api/token-prices
 * Returns prices for all tokens or specific tokens by mint address
 * 
 * Query params:
 * - mints: comma-separated list of mint addresses (optional, max 20)
 */
export async function GET(request: NextRequest) {
  // Rate limiting
  if (isRateLimited(request)) {
    return NextResponse.json(
      { success: false, error: "Rate limit exceeded. Try again in a minute." },
      { status: 429 }
    );
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const mintsParam = searchParams.get("mints");
    
    let tokensToFetch: Array<{ mintAddress: string; ticker: string; imageUrl?: string; pumpUrl?: string }> = [];
    
    if (mintsParam) {
      // Fetch specific tokens — validate format and limit count
      const mintAddresses = mintsParam.split(",").filter(Boolean).slice(0, 20);
      tokensToFetch = mintAddresses
        .filter(mint => isValidBase58Address(mint.trim()))
        .map(mint => ({
          mintAddress: mint.trim(),
          ticker: "",
        }));
    } else {
      // Fetch all tokens from database
      const allTokens = getAllTokens(50);
      tokensToFetch = allTokens
        .filter(t => t.mint_address)
        .map(t => ({
          mintAddress: t.mint_address!,
          ticker: t.ticker,
          imageUrl: t.image_url || undefined,
          pumpUrl: t.pump_url || undefined,
        }));
    }

    // Fetch prices in parallel (with rate limiting)
    const BATCH_SIZE = 5;
    const results: TokenPriceResponse[] = [];
    
    for (let i = 0; i < tokensToFetch.length; i += BATCH_SIZE) {
      const batch = tokensToFetch.slice(i, i + BATCH_SIZE);
      
      const batchResults = await Promise.all(
        batch.map(async ({ mintAddress, ticker, imageUrl, pumpUrl }) => {
          const price = await getTokenPrice(mintAddress);
          
          if (price) {
            return {
              mintAddress,
              ticker,
              price: price.price,
              priceChange24h: price.priceChange24h,
              marketCap: price.marketCap,
              volume24h: price.volume24h,
              imageUrl,
              pumpUrl,
            };
          }
          
          return null;
        })
      );
      
      for (const r of batchResults) {
        if (r !== null) {
          results.push(r as TokenPriceResponse);
        }
      }
      
      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < tokensToFetch.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return NextResponse.json({
      success: true,
      data: results,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Error fetching token prices:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch token prices" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/token-prices
 * Returns price for a single token
 */
export async function POST(request: NextRequest) {
  // Rate limiting
  if (isRateLimited(request)) {
    return NextResponse.json(
      { success: false, error: "Rate limit exceeded" },
      { status: 429 }
    );
  }

  try {
    const body = await request.json();
    const { mintAddress } = body;
    
    if (!mintAddress || typeof mintAddress !== "string") {
      return NextResponse.json(
        { success: false, error: "mintAddress is required" },
        { status: 400 }
      );
    }

    // Validate mint address format
    if (!isValidBase58Address(mintAddress)) {
      return NextResponse.json(
        { success: false, error: "Invalid mint address format" },
        { status: 400 }
      );
    }

    const price = await getTokenPrice(mintAddress);
    
    if (!price) {
      return NextResponse.json(
        { success: false, error: "Token not found or price unavailable" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        mintAddress,
        price: price.price,
        priceChange24h: price.priceChange24h,
        marketCap: price.marketCap,
        volume24h: price.volume24h,
      },
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("Error fetching token price:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch token price" },
      { status: 500 }
    );
  }
}
