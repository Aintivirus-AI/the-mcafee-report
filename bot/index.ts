import { config } from "dotenv";
import path from "path";

// Load environment variables from .env.local
// Try multiple possible paths
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
    console.log(`Loaded environment from: ${envPath}`);
    break;
  }
}

if (!envLoaded) {
  console.warn("Could not load .env.local, trying default .env");
  config(); // Try default .env
}

import { Bot, Context, session, SessionFlavor, InlineKeyboard } from "grammy";
import OpenAI from "openai";
import { PublicKey } from "@solana/web3.js";
import { safeFetchText, isUrlSafe, sanitizeForPrompt } from "../lib/url-validator";
import {
  isWhitelisted,
  addToWhitelist,
  removeFromWhitelist,
  getWhitelist,
  getAllHeadlines,
  removeHeadline,
  createSubmission,
  getSubmissionsByUser,
  getPendingSubmissionsCount,
  detectContentType,
  getRecentSubmissionCountByUser,
  getRecentSubmissionByUrl,
  updateHeadlineImportanceScore,
  updateHeadlineMcAfeeTake,
  updateHeadlineSummary,
  getSetting,
  setSetting,
  purgeStaleSubmissions,
  getFinancialStats,
  getVisitStats,
  tickerExists,
} from "../lib/db";
import { generateMcAfeeTake, scoreHeadlineImportance, generateCoinSummary } from "../lib/mcafee-commentator";
import { saveImageBuffer, isValidRasterImage, moderateImage } from "../lib/image-store";

// Session data interface
interface SessionData {
  step: "idle" | "awaiting_url" | "awaiting_headline_choice" | "awaiting_image_choice" | "awaiting_column" | "awaiting_main_url" | "awaiting_main_headline_choice" | "awaiting_main_image_choice" | "awaiting_main_subtitle" | "awaiting_submit_url" | "awaiting_sol_address" | "awaiting_token_name" | "awaiting_custom_image" | "awaiting_memeify_choice" | "awaiting_cotd_url" | "awaiting_cotd_headline_choice" | "awaiting_cotd_image_choice" | "awaiting_cotd_description";
  pendingUrl?: string;
  pendingTitle?: string;
  pendingColumn?: "left" | "right";
  pendingImageUrl?: string;
  includeImage?: boolean;
  generatedHeadlines?: string[];
  pendingSolAddress?: string;
  pendingTokenName?: string;
  pendingTicker?: string;
  pendingCustomImagePath?: string;
  pendingMemeifyImage?: boolean;
  pendingPageContent?: { title: string; description: string; content: string; imageUrl: string | null };
}

type MyContext = Context & SessionFlavor<SessionData>;

// Environment variables
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
const API_SECRET = process.env.API_SECRET_KEY;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").filter(Boolean);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

if (!API_SECRET) {
  console.error("API_SECRET_KEY is required");
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required");
  process.exit(1);
}

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Create bot instance
const bot = new Bot<MyContext>(BOT_TOKEN);

// Session middleware
bot.use(
  session({
    initial: (): SessionData => ({
      step: "idle",
    }),
  })
);

// Helper: Check if user is admin
function isAdmin(userId: number): boolean {
  return ADMIN_IDS.includes(userId.toString());
}

// Helper: Check authorization (whitelist or admin)
function isAuthorized(userId: number): boolean {
  return isAdmin(userId) || isWhitelisted(userId.toString());
}

// Helper: Escape Markdown special characters
function escapeMarkdown(text: string): string {
  return text.replace(/([_*`\[\]])/g, '\\$1');
}

// Helper: Make API request
async function apiRequest(
  endpoint: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: object
): Promise<Response> {
  const url = `${API_URL}/api${endpoint}`;
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_SECRET!,
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }
  return fetch(url, options);
}

// Helper: Validate Solana address using the actual PublicKey constructor
function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

// Helper: Check if URL is a YouTube link
function isYouTubeUrl(url: string): boolean {
  return url.includes("youtube.com") || url.includes("youtu.be");
}

// Helper: Extract YouTube video ID from URL
function getYouTubeVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Helper: Fetch YouTube video info using oEmbed API (with safe fetch)
async function fetchYouTubeContent(url: string): Promise<{ title: string; description: string; content: string; imageUrl: string | null }> {
  const videoId = getYouTubeVideoId(url);
  
  try {
    // Use YouTube oEmbed to get basic info
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const oembedText = await safeFetchText(oembedUrl, { timeoutMs: 5_000 });
    const oembedData = JSON.parse(oembedText);
    
    // Also fetch the page to get the description
    const html = await safeFetchText(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeoutMs: 10_000,
    });
    
    // Extract description from meta tags
    const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i) ||
                        html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
    const description = ogDescMatch ? ogDescMatch[1].trim() : "";
    
    // Get thumbnail
    const imageUrl = videoId ? `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg` : oembedData.thumbnail_url || null;
    
    return {
      title: oembedData.title || "",
      description: description,
      content: description,
      imageUrl,
    };
  } catch (error) {
    console.error("Error fetching YouTube content:", error);
    return fetchRegularPageContent(url);
  }
}

// Browser-like headers to avoid bot blocking by major news sites
const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  "Sec-Ch-Ua":
    '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

// Facebook's link preview crawler — sites MUST serve content to this for social sharing
const SOCIAL_CRAWLER_HEADERS: Record<string, string> = {
  "User-Agent":
    "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

// Garbage titles that indicate we got an error page instead of the article
const GARBAGE_TITLE_PATTERNS = [
  /^google($|\s*search)/i,
  /^yahoo($|\s*$)/i,
  /^access\s*denied/i,
  /^403\s*forbidden/i,
  /^404/i,
  /^error/i,
  /^just\s*a\s*moment/i,
  /^attention\s*required/i,
  /^blocked/i,
  /^verify\s*(you\s*are\s*)?human/i,
  /^oops/i,
  /^something\s*went\s*wrong/i,
  /^sign\s*in/i,
  /^page\s*not\s*found/i,
];

function isBotGarbageTitle(title: string): boolean {
  if (!title || title.length < 10) return true;
  return GARBAGE_TITLE_PATTERNS.some((p) => p.test(title.trim()));
}

// Helper: Extract content from HTML (shared between direct fetch and fallbacks)
/** Decode HTML entities (named, decimal &#39;, and hex &#x27;). */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&mdash;": "—",
    "&ndash;": "–", "&lsquo;": "\u2018", "&rsquo;": "\u2019",
    "&ldquo;": "\u201C", "&rdquo;": "\u201D", "&hellip;": "…",
  };
  return text.replace(/&[^;]+;/g, (m) => {
    if (named[m]) return named[m];
    const hex = m.match(/^&#x([0-9a-fA-F]+);$/);
    if (hex) { const c = parseInt(hex[1], 16); if (c > 0 && c <= 0x10ffff) return String.fromCodePoint(c); }
    const dec = m.match(/^&#(\d+);$/);
    if (dec) { const c = parseInt(dec[1], 10); if (c > 0 && c <= 0x10ffff) return String.fromCodePoint(c); }
    return m;
  });
}

function extractFromHtml(html: string): { title: string; description: string; content: string; imageUrl: string | null } {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "";

  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                    html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
  const description = descMatch ? decodeEntities(descMatch[1].trim()) : "";

  const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                       html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  const ogTitle = ogTitleMatch ? decodeEntities(ogTitleMatch[1].trim()) : "";

  const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
  const ogDescription = ogDescMatch ? decodeEntities(ogDescMatch[1].trim()) : "";

  const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                       html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  let imageUrl = ogImageMatch ? ogImageMatch[1].trim() : null;

  if (!imageUrl) {
    const twitterImageMatch = html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i) ||
                              html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i);
    imageUrl = twitterImageMatch ? twitterImageMatch[1].trim() : null;
  }

  // JSON-LD structured data
  let ldTitle = "";
  let ldDescription = "";
  let ldContent = "";
  let ldImage: string | null = null;

  const jsonLdBlocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const match of jsonLdBlocks) {
    try {
      const ld = JSON.parse(match[1].trim());
      const items = Array.isArray(ld) ? ld : [ld];
      for (const item of items) {
        const itemType = item["@type"] || "";
        const isArticle = /article|newsarticle|webpage|blogposting/i.test(
          Array.isArray(itemType) ? itemType.join(" ") : itemType
        );
        if (isArticle || item.headline) {
          ldTitle = ldTitle || item.headline || item.name || "";
          ldDescription = ldDescription || item.description || item.abstract || "";
          ldContent = ldContent || item.articleBody || item.text || "";
          if (!ldImage) {
            if (typeof item.image === "string") ldImage = item.image;
            else if (item.image?.url) ldImage = item.image.url;
            else if (Array.isArray(item.image) && item.image[0]) {
              ldImage = typeof item.image[0] === "string" ? item.image[0] : item.image[0]?.url || null;
            }
          }
        }
      }
    } catch { /* malformed JSON-LD */ }
  }

  const paragraphMatch = html.match(/<p[^>]*>([^<]{50,500})<\/p>/i);
  const paragraphText = paragraphMatch ? paragraphMatch[1].replace(/<[^>]+>/g, "").trim() : "";

  return {
    title: ogTitle || ldTitle || title,
    description: ogDescription || ldDescription || description,
    content: ldContent?.substring(0, 1000) || paragraphText,
    imageUrl: imageUrl || ldImage,
  };
}

// Helper: Fetch regular page content with multiple fallback strategies
async function fetchRegularPageContent(url: string): Promise<{ title: string; description: string; content: string; imageUrl: string | null }> {
  // Attempt 1: Direct fetch with browser headers
  try {
    const html = await safeFetchText(url, { headers: BROWSER_HEADERS, timeoutMs: 15_000 });
    const result = extractFromHtml(html);
    if (!isBotGarbageTitle(result.title)) {
      return result;
    }
    console.warn(`[Bot] Direct fetch returned garbage for ${url}: "${result.title}"`);
  } catch (error) {
    console.warn(`[Bot] Direct fetch failed for ${url}:`, error);
  }

  // Attempt 2: Social media crawler (most reliable — sites serve content to Facebook's crawler)
  try {
    console.log(`[Bot] Trying social media crawler for ${url}`);
    const html = await safeFetchText(url, { headers: SOCIAL_CRAWLER_HEADERS, timeoutMs: 15_000 });
    const result = extractFromHtml(html);
    if (!isBotGarbageTitle(result.title)) {
      console.log(`[Bot] Social crawler hit for ${url}: "${result.title}"`);
      return result;
    }
    console.warn(`[Bot] Social crawler returned garbage for ${url}: "${result.title}"`);
  } catch (error) {
    console.warn(`[Bot] Social crawler failed for ${url}:`, error);
  }

  // Attempt 3: Google webcache
  try {
    const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${url}&strip=1`;
    console.log(`[Bot] Trying webcache for ${url}`);
    const html = await safeFetchText(cacheUrl, { headers: BROWSER_HEADERS, timeoutMs: 10_000 });
    const result = extractFromHtml(html);
    if (!isBotGarbageTitle(result.title)) {
      console.log(`[Bot] Webcache hit for ${url}: "${result.title}"`);
      return result;
    }
    console.warn(`[Bot] Webcache returned garbage for ${url}: "${result.title}"`);
  } catch (error) {
    console.warn(`[Bot] Webcache failed for ${url}:`, error);
  }

  console.error(`[Bot] All fetch strategies failed for ${url}`);
  return { title: "", description: "", content: "", imageUrl: null };
}

// Helper: Check if URL is a Twitter/X link
function isTwitterUrl(url: string): boolean {
  return url.includes("twitter.com") || url.includes("x.com");
}

// Helper: Check if URL is a TikTok link
function isTikTokUrl(url: string): boolean {
  return url.includes("tiktok.com");
}

// Helper: Fetch Twitter/X content using oEmbed API (with safe fetch)
async function fetchTwitterContent(url: string): Promise<{ title: string; description: string; content: string; imageUrl: string | null }> {
  try {
    // Normalize x.com → twitter.com for oEmbed compatibility
    const normalizedUrl = url.replace(
      /^(https?:\/\/)(?:x\.com|twitter\.com)/i,
      "$1twitter.com"
    );

    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(normalizedUrl)}&omit_script=true`;
    const oembedText = await safeFetchText(oembedUrl, { timeoutMs: 8_000 });
    const oembedData = JSON.parse(oembedText);

    // Extract just the tweet body from the oEmbed HTML.
    // Structure: <blockquote><p>tweet text</p>&mdash; Author <a>Date</a></blockquote>
    // We grab only the <p> content and strip media links.
    const tweetHtml: string = oembedData.html || "";
    const pMatch = tweetHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    let tweetBodyHtml = pMatch ? pMatch[1] : tweetHtml;

    // Remove pic.twitter.com and t.co media links
    tweetBodyHtml = tweetBodyHtml
      .replace(/<a[^>]*>\s*pic\.twitter\.com\/\w+\s*<\/a>/gi, "")
      .replace(/<a[^>]*>\s*https?:\/\/t\.co\/\w+\s*<\/a>/gi, "");

    const tweetText = tweetBodyHtml
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<a[^>]*>(.*?)<\/a>/gi, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&mdash;/g, "—")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

    const authorName: string = oembedData.author_name || "";
    const authorHandle: string = oembedData.author_url
      ? oembedData.author_url.replace(/^https?:\/\/(twitter|x)\.com\//i, "@")
      : "";

    const title = authorHandle
      ? `${authorName} (${authorHandle})`
      : authorName || "Tweet";

    // Try to get OG image from the page
    let imageUrl: string | null = null;
    try {
      const pageContent = await fetchRegularPageContent(url);
      imageUrl = pageContent.imageUrl;
    } catch {
      // Best-effort
    }

    return {
      title,
      description: tweetText.substring(0, 300),
      content: tweetText,
      imageUrl,
    };
  } catch (error) {
    console.error("Error fetching Twitter content via oEmbed:", error);
    return fetchRegularPageContent(url);
  }
}

// Helper: Fetch TikTok content using oEmbed API (with safe fetch)
async function fetchTikTokContent(url: string): Promise<{ title: string; description: string; content: string; imageUrl: string | null }> {
  try {
    const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
    const oembedText = await safeFetchText(oembedUrl, { timeoutMs: 8_000 });
    const oembedData = JSON.parse(oembedText);

    const title = oembedData.title || oembedData.author_name || "TikTok Video";
    const authorName: string = oembedData.author_name || "";
    const authorHandle: string = oembedData.author_unique_id
      ? `@${oembedData.author_unique_id}`
      : "";

    const description = authorHandle
      ? `${authorName} (${authorHandle}): ${title}`
      : `${authorName}: ${title}`;

    return {
      title,
      description: description.substring(0, 300),
      content: title,
      imageUrl: oembedData.thumbnail_url || null,
    };
  } catch (error) {
    console.error("Error fetching TikTok content via oEmbed:", error);
    return fetchRegularPageContent(url);
  }
}

async function fetchPageContent(url: string): Promise<{ title: string; description: string; content: string; imageUrl: string | null }> {
  // Use platform-specific fetching
  if (isYouTubeUrl(url)) {
    return fetchYouTubeContent(url);
  }
  if (isTwitterUrl(url)) {
    return fetchTwitterContent(url);
  }
  if (isTikTokUrl(url)) {
    return fetchTikTokContent(url);
  }
  return fetchRegularPageContent(url);
}

// Helper: Generate headlines using OpenAI
async function generateHeadlines(url: string, pageData: { title: string; description: string; content: string }): Promise<string[]> {
  const prompt = `You are John McAfee's AI headline writer for The McAfee Report — a Drudge Report-style crypto news aggregator. Write headlines like McAfee would: provocative, irreverent, anti-establishment, darkly funny, and always cutting to the truth they don't want you to see.

Based on the following article information, generate 3 different punchy, McAfee-style headline options.

URL: ${url}
Original Title: ${sanitizeForPrompt(pageData.title, 200)}
Description: ${sanitizeForPrompt(pageData.description, 300)}
Content Preview: ${sanitizeForPrompt(pageData.content, 500)}

Requirements:
- Headlines should be concise (under 80 characters)
- Channel McAfee: bold, paranoid, freedom-obsessed, darkly humorous
- Use active voice and strong verbs — make it feel URGENT
- If it's about government/regulation, lean into the anti-authority angle
- If it's about crypto/markets, make it feel like insider knowledge
- ALL CAPS is acceptable for emphasis on key words (like Drudge Report)
- Make the reader think "holy shit, I need to click this"

Return ONLY the 3 headlines, one per line, numbered 1-3. No other text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.8,
      max_tokens: 300,
    });

    const response = completion.choices[0]?.message?.content || "";
    
    // Parse the numbered headlines
    const lines = response.split("\n").filter(line => line.trim());
    const headlines = lines
      .map(line => line.replace(/^\d+[\.\)]\s*/, "").trim())
      .filter(h => h.length > 0)
      .slice(0, 3);

    // Fallback to original title if AI fails
    if (headlines.length === 0 && pageData.title) {
      return [pageData.title];
    }

    return headlines;
  } catch (error) {
    console.error("Error generating headlines:", error);
    // Fallback to original title
    if (pageData.title) {
      return [pageData.title];
    }
    return ["[Could not generate headline - please enter manually]"];
  }
}

// Helper: Generate Coin Of The Day title options using OpenAI
async function generateCotdHeadlines(url: string, pageData: { title: string; description: string; content: string }): Promise<string[]> {
  const prompt = `You are writing the "Coin Of The Day" feature title for The McAfee Report — a crypto news aggregator. This highlights a single crypto project each day.

Based on the following project page, generate 3 short, punchy title options for the featured coin/project.

URL: ${url}
Original Title: ${sanitizeForPrompt(pageData.title, 200)}
Description: ${sanitizeForPrompt(pageData.description, 300)}
Content Preview: ${sanitizeForPrompt(pageData.content, 500)}

Requirements:
- Keep titles concise (under 60 characters)
- Make the project sound interesting and worth checking out
- Use the project/coin name if identifiable
- Be engaging but not misleading
- Plain text only — no stars, asterisks, markdown, colons, or special formatting
- Do NOT include "Coin of the Day" in the title — that prefix is added automatically

Return ONLY the 3 titles, one per line, numbered 1-3. No other text.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
      max_tokens: 200,
    });

    const response = completion.choices[0]?.message?.content || "";
    const lines = response.split("\n").filter(line => line.trim());
    const headlines = lines
      .map(line => line.replace(/^\d+[\.\)]\s*/, "").trim())
      // Strip markdown bold, stars, quotes, and leading/trailing special chars
      .map(h => h.replace(/\*+/g, "").replace(/^["']+|["']+$/g, "").trim())
      .filter(h => h.length > 0)
      .slice(0, 3);

    if (headlines.length === 0 && pageData.title) {
      return [pageData.title];
    }

    return headlines;
  } catch (error) {
    console.error("Error generating COTD headlines:", error);
    if (pageData.title) {
      return [pageData.title];
    }
    return ["[Could not generate title - please enter manually]"];
  }
}

// Helper: Reset session
function resetSession(session: SessionData) {
  session.step = "idle";
  session.pendingUrl = undefined;
  session.pendingTitle = undefined;
  session.pendingColumn = undefined;
  session.pendingImageUrl = undefined;
  session.includeImage = undefined;
  session.generatedHeadlines = undefined;
  session.pendingSolAddress = undefined;
  session.pendingTokenName = undefined;
  session.pendingTicker = undefined;
  session.pendingCustomImagePath = undefined;
  session.pendingMemeifyImage = undefined;
}

async function finalizeSubmission(ctx: MyContext, userId: number, session: SessionData) {
  try {
    const contentType = detectContentType(session.pendingUrl!);
    const submission = createSubmission(
      userId.toString(),
      session.pendingSolAddress!,
      session.pendingUrl!,
      contentType,
      ctx.from?.username,
      session.pendingTokenName,
      session.pendingTicker,
      session.pendingCustomImagePath,
      session.pendingMemeifyImage
    );

    const walletShort = `${session.pendingSolAddress!.substring(0, 6)}...${session.pendingSolAddress!.substring(session.pendingSolAddress!.length - 4)}`;
    const tokenLine = session.pendingTokenName && session.pendingTicker
      ? `Token: \`${session.pendingTokenName}\` \\($${session.pendingTicker}\\)\n`
      : `Token: _AI will generate_\n`;
    const imageLine = session.pendingCustomImagePath
      ? `Image: _Custom${session.pendingMemeifyImage ? " \\(will be meme\\-ified\\)" : ""}_\n`
      : `Image: _AI will generate_\n`;

    await ctx.reply(
      `*Submission Received*\n` +
      `─────────────────────\n\n` +
      `ID: \`#${submission.id}\`\n` +
      `URL: \`${session.pendingUrl!.substring(0, 40)}${session.pendingUrl!.length > 40 ? "\\.\\.\\." : ""}\`\n` +
      `Wallet: \`${walletShort}\`\n` +
      tokenLine +
      imageLine + `\n` +
      `AI is reviewing your submission now\\.\n` +
      `You'll be notified here when it's approved or rejected\\.\n\n` +
      `*If approved:*\n` +
      `1\\. A token launches on pump\\.fun\n` +
      `2\\. You receive 50% of creator fees\n\n` +
      `Use /mystatus to check all your submissions\\.`,
      { parse_mode: "MarkdownV2" }
    );

    // Notify admins
    for (const adminId of ADMIN_IDS) {
      try {
        const tokenInfo = session.pendingTokenName && session.pendingTicker
          ? `Token: ${session.pendingTokenName} ($${session.pendingTicker})\n`
          : "";
        const imageInfo = session.pendingCustomImagePath
          ? `Image: Custom${session.pendingMemeifyImage ? " (meme-ify)" : " (as-is)"}\n`
          : "";
        await bot.api.sendMessage(
          adminId,
          `*New Submission*\n\n` +
          `ID: \`#${submission.id}\`\n` +
          `From: ${ctx.from?.username ? `@${ctx.from.username}` : userId}\n` +
          `Type: ${contentTypeLabel(contentType)}\n` +
          `URL: \`${session.pendingUrl!.substring(0, 50)}...\`\n` +
          tokenInfo +
          imageInfo,
          { parse_mode: "Markdown" }
        );
      } catch {
        // Admin might have blocked the bot
      }
    }

    if (API_SECRET) {
      fetch(`${API_URL}/api/scheduler/trigger?action=validate`, {
        method: "POST",
        headers: { "x-api-key": API_SECRET },
      }).catch((err) =>
        console.warn("[Bot] Failed to trigger validation:", err)
      );
    }
  } catch (error) {
    console.error("Error creating submission:", error);
    await ctx.reply("Failed to create submission. Try again with /submit");
  }

  resetSession(session);
}

// Helper: Format content type as readable label
function contentTypeLabel(contentType: string): string {
  switch (contentType) {
    case "tweet": return "Tweet";
    case "youtube": return "YouTube";
    case "tiktok": return "TikTok";
    case "article": return "Article";
    default: return "Link";
  }
}

// Helper: Format status as readable label
function statusLabel(status: string): string {
  switch (status) {
    case "pending": return "Pending";
    case "validating": return "Validating";
    case "approved": return "Approved";
    case "rejected": return "Rejected";
    case "published": return "Published";
    default: return status;
  }
}

// ============================================================
//  COMMANDS
// ============================================================

// /start
bot.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const authorized = isAuthorized(userId);
  const admin = isAdmin(userId);

  let msg = `*THE MCAFEE REPORT*\n`;
  msg += `─────────────────────\n\n`;

  msg += `*Public*\n`;
  msg += `/submit  — Submit a news link\n`;
  msg += `/mystatus — Your submissions\n\n`;

  if (authorized) {
    msg += `*Editor* (${admin ? "admin" : "whitelisted"})\n`;
    msg += `/add  — Add headline (AI-generated)\n`;
    msg += `/main — Set main headline\n`;
    msg += `/cotd — Set Coin of the Day\n`;
    msg += `/list — Recent headlines\n`;
    msg += `/remove — Remove a headline\n`;

    if (admin) {
      msg += `\n*Admin*\n`;
      msg += `/whitelist — View whitelist\n`;
      msg += `/adduser — Add to whitelist\n`;
      msg += `/removeuser — Remove from whitelist\n`;
      msg += `/queue — Submission queue\n`;
      msg += `/finances — Financial statistics\n`;
      msg += `/visits — Visit statistics\n`;
    }
  }

  msg += `\n/help — Full command reference`;

  await ctx.reply(msg, { parse_mode: "Markdown" });
});

// /help
bot.command("help", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const authorized = isAuthorized(userId);
  const admin = isAdmin(userId);

  let msg = `*COMMAND REFERENCE*\n`;
  msg += `─────────────────────\n\n`;

  msg += `*Public Commands*\n`;
  msg += `/submit — Submit breaking news\n`;
  msg += `  Accepts articles, tweets, YouTube, TikTok.\n`;
  msg += `  Approved stories launch a token on pump.fun.\n`;
  msg += `  You receive 50% of creator fees.\n`;
  msg += `/mystatus — View your submission history\n`;
  msg += `/cancel — Cancel current operation\n`;

  if (authorized) {
    msg += `\n*Editor Commands*\n`;
    msg += `/add — Send a URL, AI generates headline options\n`;
    msg += `/main — Set the main/center headline\n`;
    msg += `/cotd — Set Coin of the Day (no token created)\n`;
    msg += `/list — View recent headlines with IDs\n`;
    msg += `/remove <id> — Remove a headline by ID\n`;
  }

  if (admin) {
    msg += `\n*Admin Commands*\n`;
    msg += `/whitelist — View all whitelisted users\n`;
    msg += `/adduser <id> [username] — Add to whitelist\n`;
    msg += `/removeuser <id> — Remove from whitelist\n`;
    msg += `/queue — View pending submission queue\n`;
    msg += `/finances [day|week|all] — Financial statistics\n`;
    msg += `/visits — Page view stats (today/week/month)\n`;
  }

  msg += `\n${API_URL}`;

  await ctx.reply(msg, { parse_mode: "Markdown" });
});

// /add
bot.command("add", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) {
    await ctx.reply("Not authorized.");
    return;
  }

  ctx.session.step = "awaiting_url";
  await ctx.reply(
    `*Add Headline*\n\nSend the article URL:`,
    { parse_mode: "Markdown" }
  );
});

// /main
bot.command("main", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) {
    await ctx.reply("Not authorized.");
    return;
  }

  ctx.session.step = "awaiting_main_url";
  await ctx.reply(
    `*Set Main Headline*\n\nSend the article URL:`,
    { parse_mode: "Markdown" }
  );
});

// /cotd
bot.command("cotd", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) {
    await ctx.reply("Not authorized.");
    return;
  }

  ctx.session.step = "awaiting_cotd_url";
  await ctx.reply(
    `*Set Coin of the Day*\n\nSend the project URL (no pump.fun token will be created):`,
    { parse_mode: "Markdown" }
  );
});

// /list
bot.command("list", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) {
    await ctx.reply("Not authorized.");
    return;
  }

  try {
    const headlines = getAllHeadlines(20);

    if (headlines.length === 0) {
      await ctx.reply("No headlines found.");
      return;
    }

    let msg = `*Recent Headlines*\n`;
    msg += `─────────────────────\n\n`;
    for (const h of headlines) {
      const col = h.column === "left" ? "L" : h.column === "right" ? "R" : "C";
      const img = h.image_url ? " [img]" : "";
      const title = h.title.length > 40 ? h.title.substring(0, 37) + "..." : h.title;
      msg += `\`${h.id}\` [${col}]${img} ${title}\n`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error listing headlines:", error);
    await ctx.reply("Failed to fetch headlines.");
  }
});

// /remove
bot.command("remove", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAuthorized(userId)) {
    await ctx.reply("Not authorized.");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1);
  if (!args || args.length === 0) {
    await ctx.reply(
      "Usage: `/remove <id>`\nUse `/list` to see IDs.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const id = parseInt(args[0], 10);
  if (isNaN(id)) {
    await ctx.reply("Invalid ID. Provide a number.");
    return;
  }

  try {
    const deleted = removeHeadline(id);
    if (deleted) {
      await ctx.reply(`Removed headline #${id}.`);
    } else {
      await ctx.reply(`Headline #${id} not found.`);
    }
  } catch (error) {
    console.error("Error removing headline:", error);
    await ctx.reply("Failed to remove headline.");
  }
});

// /cancel
bot.command("cancel", async (ctx) => {
  resetSession(ctx.session);
  await ctx.reply("Cancelled.");
});

// ============================================================
//  PUBLIC SUBMISSION COMMANDS
// ============================================================

// /submit
bot.command("submit", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  ctx.session.step = "awaiting_submit_url";

  const pendingCount = getPendingSubmissionsCount();

  await ctx.reply(
    `*Submit Breaking News*\n` +
    `─────────────────────\n\n` +
    `Send a news link to earn rewards.\n\n` +
    `*Process:*\n` +
    `1. Send a URL (article, tweet, YouTube, TikTok)\n` +
    `2. Provide your Solana wallet address\n` +
    `3. Name your token (or let AI pick)\n` +
    `4. Send a logo image (or let AI create one)\n` +
    `5. AI reviews your submission\n` +
    `6. If approved, a token launches on pump.fun\n` +
    `7. You receive 50% of creator fees\n\n` +
    `*Rules:*\n` +
    `- Must be real, verifiable news\n` +
    `- Must be recent (under 24 hours old)\n` +
    `- No duplicates\n\n` +
    `Queue: ${pendingCount} pending\n\n` +
    `Send the URL:`,
    { parse_mode: "Markdown" }
  );
});

// /mystatus
bot.command("mystatus", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    const submissions = getSubmissionsByUser(userId.toString(), 10);

    if (submissions.length === 0) {
      await ctx.reply(
        `*No Submissions*\n\nUse /submit to send your first news link.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    let msg = `*Your Submissions*\n`;
    msg += `─────────────────────\n\n`;

    for (const sub of submissions) {
      const type = contentTypeLabel(sub.content_type);
      const status = statusLabel(sub.status);
      const shortUrl = sub.url.length > 35 ? sub.url.substring(0, 32) + "..." : sub.url;

      msg += `\`#${sub.id}\` — *${status}*\n`;
      msg += `${type}: \`${shortUrl}\`\n`;
      if (sub.rejection_reason) {
        msg += `Reason: ${sub.rejection_reason}\n`;
      }
      msg += `\n`;
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error fetching submissions:", error);
    await ctx.reply("Failed to fetch submissions. Try again.");
  }
});

// /queue (admin)
bot.command("queue", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) {
    await ctx.reply("Admin only.");
    return;
  }

  try {
    const { getSubmissionsByStatus } = await import("../lib/db");
    const pending = getSubmissionsByStatus("pending", 20);
    const validating = getSubmissionsByStatus("validating", 10);
    const approved = getSubmissionsByStatus("approved", 10);

    let msg = `*Submission Queue*\n`;
    msg += `─────────────────────\n\n`;

    msg += `*Pending* (${pending.length})\n`;
    if (pending.length === 0) {
      msg += `  None\n`;
    } else {
      for (const sub of pending.slice(0, 5)) {
        msg += `  \`#${sub.id}\` \`${sub.url.substring(0, 30)}...\`\n`;
      }
      if (pending.length > 5) msg += `  +${pending.length - 5} more\n`;
    }

    msg += `\n*Validating* (${validating.length})\n`;
    if (validating.length === 0) {
      msg += `  None\n`;
    } else {
      for (const sub of validating.slice(0, 3)) {
        msg += `  \`#${sub.id}\` \`${sub.url.substring(0, 30)}...\`\n`;
      }
    }

    msg += `\n*Approved, waiting* (${approved.length})\n`;
    if (approved.length === 0) {
      msg += `  None\n`;
    } else {
      for (const sub of approved.slice(0, 3)) {
        msg += `  \`#${sub.id}\` \`${sub.url.substring(0, 30)}...\`\n`;
      }
    }

    await ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error fetching queue:", error);
    await ctx.reply("Failed to fetch queue.");
  }
});

// /whitelist (admin)
bot.command("whitelist", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) {
    await ctx.reply("Admin only.");
    return;
  }

  const users = getWhitelist();

  if (users.length === 0) {
    await ctx.reply("Whitelist is empty.");
    return;
  }

  let msg = `*Whitelisted Users*\n`;
  msg += `─────────────────────\n\n`;
  for (const user of users) {
    msg += `\`${user.telegram_id}\`${user.username ? ` @${user.username}` : ""}\n`;
  }

  await ctx.reply(msg, { parse_mode: "Markdown" });
});

// /adduser (admin)
bot.command("adduser", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) {
    await ctx.reply("Admin only.");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1);
  if (!args || args.length === 0) {
    await ctx.reply("Usage: `/adduser <telegram_id> [username]`", {
      parse_mode: "Markdown",
    });
    return;
  }

  const telegramId = args[0];
  const username = args[1];

  try {
    addToWhitelist(telegramId, username);
    await ctx.reply(`Added \`${telegramId}\` to whitelist.`, {
      parse_mode: "Markdown",
    });
  } catch (error) {
    console.error("Error adding to whitelist:", error);
    await ctx.reply("Failed to add user.");
  }
});

// /removeuser (admin)
bot.command("removeuser", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) {
    await ctx.reply("Admin only.");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1);
  if (!args || args.length === 0) {
    await ctx.reply("Usage: `/removeuser <telegram_id>`", {
      parse_mode: "Markdown",
    });
    return;
  }

  const telegramId = args[0];

  try {
    const removed = removeFromWhitelist(telegramId);
    if (removed) {
      await ctx.reply(`Removed \`${telegramId}\` from whitelist.`, {
        parse_mode: "Markdown",
      });
    } else {
      await ctx.reply(`\`${telegramId}\` not found in whitelist.`, {
        parse_mode: "Markdown",
      });
    }
  } catch (error) {
    console.error("Error removing from whitelist:", error);
    await ctx.reply("Failed to remove user.");
  }
});

// /purge (admin) — remove stale pending/approved submissions older than N hours
bot.command("purge", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) {
    await ctx.reply("Admin only.");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1);
  const hours = parseInt(args?.[0] || "72", 10);

  if (isNaN(hours) || hours < 1) {
    await ctx.reply("Usage: `/purge [hours]`\nDefault: 72 hours", { parse_mode: "Markdown" });
    return;
  }

  const deleted = purgeStaleSubmissions(hours);
  await ctx.reply(
    `Purged *${deleted}* stale submission(s) older than ${hours} hours.\n(pending, validating, and approved only — published/rejected are kept)`,
    { parse_mode: "Markdown" }
  );
});

// /mayhem (admin) — toggle pump.fun Mayhem Mode
bot.command("mayhem", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) {
    await ctx.reply("Admin only.");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1);
  const action = args?.[0]?.toLowerCase();

  if (action === "on") {
    setSetting("mayhem_mode", "on");
    await ctx.reply("Mayhem Mode *ENABLED*\n\nNew token deployments will use pump.fun create\\_v2 with Mayhem Mode.", {
      parse_mode: "Markdown",
    });
  } else if (action === "off") {
    setSetting("mayhem_mode", "off");
    await ctx.reply("Mayhem Mode *DISABLED*\n\nToken deployments will use standard mode.", {
      parse_mode: "Markdown",
    });
  } else {
    const current = getSetting("mayhem_mode") === "on";
    await ctx.reply(
      `*Mayhem Mode:* ${current ? "ON" : "OFF"}\n\nUsage: \`/mayhem on\` or \`/mayhem off\``,
      { parse_mode: "Markdown" }
    );
  }
});

// /finances (admin) — financial statistics
bot.command("finances", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) {
    await ctx.reply("Admin only.");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1);
  const period = args?.[0]?.toLowerCase() || "all";

  if (!["day", "week", "all"].includes(period)) {
    await ctx.reply(
      "Usage: `/finances [day|week|all]`\nDefault: all time",
      { parse_mode: "Markdown" }
    );
    return;
  }

  try {
    const LAMPORTS_PER_SOL = 1_000_000_000;
    const stats = getFinancialStats(period);

    const fmt = (lamports: number): string => {
      return (lamports / LAMPORTS_PER_SOL).toFixed(4);
    };

    const periodLabel =
      period === "day" ? "Today (24h)" :
      period === "week" ? "This Week (7d)" :
      "All Time";

    let msg = `*FINANCIAL REPORT — ${periodLabel}*\n`;
    msg += `─────────────────────\n\n`;

    msg += `*Revenue In:* \`${fmt(stats.grossRevenue)} SOL\`\n`;
    msg += `  Fee Claims: \`${fmt(stats.revenueEventsGross)} SOL\` (${stats.revenueEventsCount} events)\n`;
    msg += `  Bulk Claims: \`${fmt(stats.claimBatchesGross)} SOL\` (${stats.claimBatchesCount} batches)\n\n`;

    msg += `*Total Spent:* \`${fmt(stats.totalSpent)} SOL\`\n`;
    msg += `  Submitter Payouts: \`${fmt(stats.totalPaidToSubmitters)} SOL\`\n`;
    msg += `  Token Minting: \`${fmt(stats.mintingCostLamports)} SOL\` (${stats.mintingCount} tokens)\n`;
    if (stats.totalPoolFundedCount > 0) {
      msg += `  Pool Funding: \`${fmt(stats.totalPoolFundedLamports)} SOL\` (${stats.totalPoolFundedCount} wallets)\n`;
    }
    msg += `\n`;

    msg += `*Our Revenue:* \`${fmt(stats.totalRetained)} SOL\`\n`;
    msg += `*Net Profit:* \`${fmt(stats.netProfit)} SOL\`\n\n`;

    msg += `_Total Outflow: ${fmt(stats.totalOutflowLamports)} SOL (${stats.totalOutflowCount} txns)_`;

    await ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error fetching financial stats:", error);
    await ctx.reply("Failed to fetch financial statistics.");
  }
});

// /visits (admin) — page view statistics
bot.command("visits", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !isAdmin(userId)) {
    await ctx.reply("Admin only.");
    return;
  }

  try {
    const stats = getVisitStats();

    const fmtNum = (n: number): string => n.toLocaleString("en-US");

    let msg = `*VISIT STATS*\n`;
    msg += `─────────────────────\n\n`;
    msg += `*Today:*      \`${fmtNum(stats.today)}\` views (${fmtNum(stats.uniqueToday)} unique)\n`;
    msg += `*This Week:*  \`${fmtNum(stats.week)}\` views (${fmtNum(stats.uniqueWeek)} unique)\n`;
    msg += `*This Month:* \`${fmtNum(stats.month)}\` views (${fmtNum(stats.uniqueMonth)} unique)\n`;

    await ctx.reply(msg, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error fetching visit stats:", error);
    await ctx.reply("Failed to fetch visit statistics.");
  }
});

// ============================================================
//  PHOTO HANDLER (custom token image upload)
// ============================================================

bot.on("message:photo", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const session = ctx.session;
  if (session.step !== "awaiting_custom_image") return;

  try {
    await ctx.reply("Processing your image...");

    // Grab the largest photo size (last in the array)
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];

    const file = await ctx.api.getFile(largest.file_id);
    if (!file.file_path) {
      await ctx.reply("Failed to download the image. Try sending it again, or /skip.");
      return;
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    if (!response.ok) {
      await ctx.reply("Failed to download the image. Try again, or /skip.");
      return;
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());

    if (imageBuffer.length > 10 * 1024 * 1024) {
      await ctx.reply("Image too large (max 10 MB). Send a smaller photo, or /skip.");
      return;
    }

    if (!isValidRasterImage(imageBuffer)) {
      await ctx.reply("Invalid image format. Send a PNG, JPEG, GIF, or WebP photo, or /skip.");
      return;
    }

    // Screen for NSFW / policy violations via OpenAI moderation
    const imageBase64 = imageBuffer.toString("base64");
    const moderation = await moderateImage(imageBase64);

    if (!moderation.safe) {
      const categories = moderation.flaggedCategories.join(", ");
      await ctx.reply(
        `Image rejected (policy violation: ${categories}).\n\nSend a different photo, or /skip.`
      );
      return;
    }

    // Save to /public/tokens/
    const identifier = `user-${userId}-${Date.now()}`;
    const localPath = saveImageBuffer(imageBuffer, identifier);
    session.pendingCustomImagePath = localPath;

    // Ask: use as-is or meme-ify?
    session.step = "awaiting_memeify_choice";
    const keyboard = new InlineKeyboard()
      .text("Use as-is", "memeify_no")
      .text("Meme-ify it", "memeify_yes");

    await ctx.reply(
      "Image received! How should we use it?\n\n" +
      "*Use as-is* — your image becomes the token logo directly\n" +
      "*Meme-ify it* — AI deep-fries it into meme coin energy",
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  } catch (error) {
    console.error("[Bot] Photo upload error:", error);
    await ctx.reply("Something went wrong processing your image. Try again, or /skip.");
  }
});

// ============================================================
//  MESSAGE HANDLER (interactive flows)
// ============================================================

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const text = ctx.message.text;
  const session = ctx.session;

  // ---- PUBLIC SUBMISSION FLOW ----

  if (session.step === "awaiting_submit_url") {
    try {
      new URL(text);
    } catch {
      await ctx.reply("Invalid URL. Send a valid link:");
      return;
    }

    const urlCheck = isUrlSafe(text);
    if (!urlCheck.safe) {
      await ctx.reply(`URL not allowed: ${urlCheck.reason}`);
      return;
    }

    session.pendingUrl = text;
    session.step = "awaiting_sol_address";

    const contentType = detectContentType(text);

    await ctx.reply(
      `*Link received*\n\n` +
      `Type: ${contentTypeLabel(contentType)}\n` +
      `URL: \`${text.substring(0, 50)}${text.length > 50 ? "..." : ""}\`\n\n` +
      `Send your *Solana wallet address*:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (session.step === "awaiting_sol_address") {
    if (!isValidSolanaAddress(text)) {
      await ctx.reply(
        "Invalid Solana address.\n\nSend a valid wallet address (base58, 32-44 chars):"
      );
      return;
    }

    session.pendingSolAddress = text;

    // Admins bypass the hourly submission rate limit
    if (!isAdmin(userId)) {
      const recentCount = getRecentSubmissionCountByUser(userId.toString(), 1);
      if (recentCount >= 5) {
        await ctx.reply(
          `*Rate limit*\n\nMax 5 submissions per hour. Try again later.`,
          { parse_mode: "Markdown" }
        );
        resetSession(session);
        return;
      }
    }

    const existingSubmission = getRecentSubmissionByUrl(session.pendingUrl!, 48);
    if (existingSubmission) {
      await ctx.reply(
        `This URL was already submitted (submission #${existingSubmission.id}).\nSend a different link.`
      );
      resetSession(session);
      return;
    }

    session.step = "awaiting_token_name";
    await ctx.reply(
      `*Name Your Token \\(Optional\\)*\n` +
      `─────────────────────\n\n` +
      `Want to pick a name and ticker for your memecoin?\n\n` +
      `Send it as: \`Name / TICKER\`\n` +
      `Example: \`Moon Dog / MOONDOG\`\n\n` +
      `*Rules:*\n` +
      `\\- Name: 1\\-30 characters\n` +
      `\\- Ticker: 3\\-8 uppercase letters \\(A\\-Z only\\)\n\n` +
      `Or send /skip to let AI name it\\.`,
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  if (session.step === "awaiting_token_name") {
    const trimmed = text.trim();

    if (trimmed.toLowerCase() === "/skip" || trimmed.toLowerCase() === "skip") {
      // No custom name — AI will generate
      session.step = "awaiting_custom_image";
      await ctx.reply(
        `*Token Logo \\(Optional\\)*\n` +
        `─────────────────────\n\n` +
        `Send a photo for your token logo\\.\n\n` +
        `Or send /skip to let AI create one\\.`,
        { parse_mode: "MarkdownV2" }
      );
      return;
    }

    // Parse "Name / TICKER" format
    const slashIdx = trimmed.lastIndexOf("/");
    if (slashIdx === -1) {
      await ctx.reply(
        "Use the format: `Name / TICKER`\nExample: `Moon Dog / MOONDOG`\n\nOr send /skip to let AI name it.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const rawName = trimmed.substring(0, slashIdx).trim();
    const rawTicker = trimmed.substring(slashIdx + 1).trim().toUpperCase().replace(/[^A-Z]/g, "");

    if (rawName.length < 1 || rawName.length > 30) {
      await ctx.reply(
        "Token name must be 1-30 characters.\n\nTry again or send /skip.",
      );
      return;
    }

    if (rawTicker.length < 3 || rawTicker.length > 8) {
      await ctx.reply(
        "Ticker must be 3-8 uppercase letters (A-Z only).\n\nTry again or send /skip.",
      );
      return;
    }

    if (tickerExists(rawTicker)) {
      await ctx.reply(
        `Ticker \`${rawTicker}\` is already taken. Pick another one or send /skip.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    session.pendingTokenName = rawName;
    session.pendingTicker = rawTicker;
    session.step = "awaiting_custom_image";
    await ctx.reply(
      `*Token Logo \\(Optional\\)*\n` +
      `─────────────────────\n\n` +
      `Send a photo for your token logo\\.\n\n` +
      `Or send /skip to let AI create one\\.`,
      { parse_mode: "MarkdownV2" }
    );
    return;
  }

  if (session.step === "awaiting_custom_image") {
    if (text.toLowerCase() === "/skip" || text.toLowerCase() === "skip") {
      await finalizeSubmission(ctx, userId, session);
      return;
    }
    await ctx.reply(
      "Send a *photo* directly, or /skip to let AI create the logo.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ---- EDITOR FLOWS ----

  if (!isAuthorized(userId)) {
    return;
  }

  // Handle /skip for COTD description
  if (text === "/skip" && session.step === "awaiting_cotd_description") {
    try {
      const cotdTitle = `Coin Of The Day: ${session.pendingTitle}`;

      // 0. Delete the previous COTD article if one exists
      try {
        const prevCotd = await apiRequest("/coin-of-the-day", "GET");
        if (prevCotd.ok) {
          const { coinOfTheDay } = await prevCotd.json();
          const oldMatch = coinOfTheDay?.url?.match(/^\/article\/(\d+)$/);
          if (oldMatch) {
            await apiRequest(`/headlines?id=${oldMatch[1]}`, "DELETE");
          }
        }
      } catch { /* non-fatal */ }

      // 1. Create a normal headline (no token will be minted)
      const headlineRes = await apiRequest("/headlines", "POST", {
        title: cotdTitle,
        url: session.pendingUrl,
        image_url: session.includeImage ? session.pendingImageUrl : undefined,
      });

      if (!headlineRes.ok) {
        const err = await headlineRes.json();
        throw new Error(err.error || "Failed to create headline");
      }

      const { headline } = await headlineRes.json();
      const articleUrl = `/article/${headline.id}`;

      // 2. Update coin_of_the_day pointer to the article page
      await apiRequest("/coin-of-the-day", "PUT", {
        title: cotdTitle,
        url: articleUrl,
        image_url: session.includeImage ? session.pendingImageUrl : undefined,
      });

      // 3. AI enrichment — importance score + McAfee take + full summary (non-blocking)
      const pageContent = session.pendingPageContent || {
        title: session.pendingTitle || "",
        description: "",
        content: "",
        imageUrl: null,
      };
      const headlineId = headline.id;

      Promise.all([
        scoreHeadlineImportance(cotdTitle, pageContent),
        generateMcAfeeTake(cotdTitle, pageContent, true),
        generateCoinSummary(cotdTitle, pageContent),
      ]).then(([importanceScore, mcafeeTake, summary]) => {
        updateHeadlineImportanceScore(headlineId, importanceScore);
        updateHeadlineMcAfeeTake(headlineId, mcafeeTake);
        updateHeadlineSummary(headlineId, summary);
        console.log(`[COTD] AI enrichment for #${headlineId}: importance=${importanceScore}, summary=${summary.length} chars`);
      }).catch(err => {
        console.warn(`[COTD] AI enrichment failed (non-fatal):`, err);
      });

      await ctx.reply(
        `*Coin of the Day published*\n` +
        `─────────────────────\n\n` +
        `Title: ${escapeMarkdown(cotdTitle)}\n` +
        `Article: \`${API_URL}${articleUrl}\`\n` +
        `Source: \`${session.pendingUrl || ""}\`\n` +
        `${session.includeImage ? "Image: included\n" : ""}` +
        `\n_Published as article — no token created._\n` +
        `_AI summary generating..._`,
        { parse_mode: "Markdown" }
      );
    } catch (error) {
      console.error("Error setting coin of the day:", error);
      await ctx.reply("Failed to set Coin of the Day. Try again.");
    }

    resetSession(session);
    return;
  }

  // Handle /skip for subtitle
  if (text === "/skip" && session.step === "awaiting_main_subtitle") {
    try {
      const response = await apiRequest("/main-headline", "PUT", {
        title: session.pendingTitle,
        url: session.pendingUrl,
        subtitle: undefined,
        image_url: session.includeImage ? session.pendingImageUrl : undefined,
      });

      if (response.ok) {
        await ctx.reply(
          `*Main headline updated*\n` +
          `─────────────────────\n\n` +
          `${escapeMarkdown(session.pendingTitle || "")}\n` +
          `URL: \`${session.pendingUrl || ""}\`\n` +
          `${session.includeImage ? "Image: included\n" : ""}` +
          `\n${API_URL}`,
          { parse_mode: "Markdown" }
        );
      } else {
        const error = await response.json();
        throw new Error(error.error || "Unknown error");
      }
    } catch (error) {
      console.error("Error setting main headline:", error);
      await ctx.reply("Failed to set main headline. Try again.");
    }

    resetSession(session);
    return;
  }

  // Skip other commands
  if (text.startsWith("/")) {
    return;
  }

  switch (session.step) {
    case "awaiting_url": {
      try {
        new URL(text);
      } catch {
        await ctx.reply("Invalid URL. Send a valid link:");
        return;
      }

      session.pendingUrl = text;
      const loadingMsg = await ctx.reply("Fetching article and generating headlines...");

      try {
        const pageData = await fetchPageContent(text);
        session.pendingImageUrl = pageData.imageUrl || undefined;

        const headlines = await generateHeadlines(text, pageData);
        session.generatedHeadlines = headlines;
        session.step = "awaiting_headline_choice";

        const keyboard = new InlineKeyboard();
        headlines.forEach((_, index) => {
          keyboard.text(`${index + 1}`, `headline_${index}`).row();
        });
        keyboard.text("Write my own", "headline_custom");

        let msg = `*Generated Headlines*\n\n`;
        headlines.forEach((headline, index) => {
          msg += `*${index + 1}.* ${headline}\n\n`;
        });
        if (pageData.imageUrl) {
          msg += `_Thumbnail available_\n\n`;
        }
        msg += "Select one or write your own:";

        await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, msg, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      } catch (error) {
        console.error("Error generating headlines:", error);
        await ctx.api.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          "Failed to generate headlines. Try again or type one manually."
        );
        session.step = "idle";
      }
      break;
    }

    case "awaiting_main_url": {
      try {
        new URL(text);
      } catch {
        await ctx.reply("Invalid URL. Send a valid link:");
        return;
      }

      session.pendingUrl = text;
      const loadingMsg = await ctx.reply("Fetching article and generating headlines...");

      try {
        const pageData = await fetchPageContent(text);
        session.pendingImageUrl = pageData.imageUrl || undefined;

        const headlines = await generateHeadlines(text, pageData);
        session.generatedHeadlines = headlines;
        session.step = "awaiting_main_headline_choice";

        const keyboard = new InlineKeyboard();
        headlines.forEach((_, index) => {
          keyboard.text(`${index + 1}`, `main_headline_${index}`).row();
        });
        keyboard.text("Write my own", "main_headline_custom");

        let msg = `*Main Headline Options*\n\n`;
        headlines.forEach((headline, index) => {
          msg += `*${index + 1}.* ${headline}\n\n`;
        });
        if (pageData.imageUrl) {
          msg += `_Thumbnail available_\n\n`;
        }
        msg += "Select one or write your own:";

        await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, msg, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      } catch (error) {
        console.error("Error generating headlines:", error);
        await ctx.api.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          "Failed to generate headlines. Try again."
        );
        session.step = "idle";
      }
      break;
    }

    case "awaiting_headline_choice": {
      session.pendingTitle = text;

      if (session.pendingImageUrl) {
        session.step = "awaiting_image_choice";

        const keyboard = new InlineKeyboard()
          .text("Yes", "image_yes")
          .text("No", "image_no");

        await ctx.reply(
          `Headline: "${text}"\n\nInclude thumbnail?`,
          { reply_markup: keyboard }
        );
      } else {
        session.step = "awaiting_column";

        const keyboard = new InlineKeyboard()
          .text("Left", "column_left")
          .text("Right", "column_right");

        await ctx.reply(`Headline: "${text}"\n\nColumn:`, {
          reply_markup: keyboard,
        });
      }
      break;
    }

    case "awaiting_main_headline_choice": {
      session.pendingTitle = text;

      if (session.pendingImageUrl) {
        session.step = "awaiting_main_image_choice";

        const keyboard = new InlineKeyboard()
          .text("Yes", "main_image_yes")
          .text("No", "main_image_no");

        await ctx.reply(
          `Headline: "${text}"\n\nInclude thumbnail?`,
          { reply_markup: keyboard }
        );
      } else {
        session.step = "awaiting_main_subtitle";
        await ctx.reply(
          `Headline: "${text}"\n\nSend a subtitle (or /skip):`
        );
      }
      break;
    }

    case "awaiting_main_subtitle": {
      const subtitle = text === "/skip" ? undefined : text;

      try {
        const response = await apiRequest("/main-headline", "PUT", {
          title: session.pendingTitle,
          url: session.pendingUrl,
          subtitle,
          image_url: session.includeImage ? session.pendingImageUrl : undefined,
        });

        if (response.ok) {
          await ctx.reply(
            `*Main headline updated*\n` +
            `─────────────────────\n\n` +
            `${escapeMarkdown(session.pendingTitle || "")}\n` +
            `URL: \`${session.pendingUrl || ""}\`\n` +
            `${subtitle ? `Subtitle: ${escapeMarkdown(subtitle)}\n` : ""}` +
            `${session.includeImage ? "Image: included\n" : ""}` +
            `\n${API_URL}`,
            { parse_mode: "Markdown" }
          );
        } else {
          const error = await response.json();
          throw new Error(error.error || "Unknown error");
        }
      } catch (error) {
        console.error("Error setting main headline:", error);
        await ctx.reply("Failed to set main headline. Try again.");
      }

      resetSession(session);
      break;
    }

    case "awaiting_cotd_url": {
      try {
        new URL(text);
      } catch {
        await ctx.reply("Invalid URL. Send a valid link:");
        return;
      }

      session.pendingUrl = text;
      const loadingMsg = await ctx.reply("Fetching project info...");

      try {
        const pageData = await fetchPageContent(text);
        session.pendingImageUrl = pageData.imageUrl || undefined;
        session.pendingPageContent = pageData;

        const headlines = await generateCotdHeadlines(text, pageData);
        session.generatedHeadlines = headlines;
        session.step = "awaiting_cotd_headline_choice";

        const keyboard = new InlineKeyboard();
        headlines.forEach((_, index) => {
          keyboard.text(`${index + 1}`, `cotd_headline_${index}`).row();
        });
        keyboard.text("Write my own", "cotd_headline_custom");

        let msg = `*Coin of the Day — Title Options*\n\n`;
        headlines.forEach((headline, index) => {
          msg += `*${index + 1}.* ${headline}\n\n`;
        });
        if (pageData.imageUrl) {
          msg += `_Project image available_\n\n`;
        }
        msg += "Select one or write your own:";

        await ctx.api.editMessageText(ctx.chat.id, loadingMsg.message_id, msg, {
          parse_mode: "Markdown",
          reply_markup: keyboard,
        });
      } catch (error) {
        console.error("Error generating COTD headlines:", error);
        await ctx.api.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          "Failed to fetch project info. Try again."
        );
        session.step = "idle";
      }
      break;
    }

    case "awaiting_cotd_headline_choice": {
      session.pendingTitle = text;

      if (session.pendingImageUrl) {
        session.step = "awaiting_cotd_image_choice";

        const keyboard = new InlineKeyboard()
          .text("Yes", "cotd_image_yes")
          .text("No", "cotd_image_no");

        await ctx.reply(
          `Title: "${text}"\n\nInclude project image?`,
          { reply_markup: keyboard }
        );
      } else {
        session.step = "awaiting_cotd_description";
        await ctx.reply(
          `Title: "${text}"\n\nSend a short description (or /skip):`
        );
      }
      break;
    }

    case "awaiting_cotd_description": {
      const description = text === "/skip" ? undefined : text;
      const cotdTitle = `Coin Of The Day: ${session.pendingTitle}`;

      try {
        // 0. Delete the previous COTD article if one exists
        try {
          const prevCotd = await apiRequest("/coin-of-the-day", "GET");
          if (prevCotd.ok) {
            const { coinOfTheDay } = await prevCotd.json();
            const oldMatch = coinOfTheDay?.url?.match(/^\/article\/(\d+)$/);
            if (oldMatch) {
              await apiRequest(`/headlines?id=${oldMatch[1]}`, "DELETE");
            }
          }
        } catch { /* non-fatal */ }

        // 1. Create a normal headline (no token will be minted)
        const headlineRes = await apiRequest("/headlines", "POST", {
          title: cotdTitle,
          url: session.pendingUrl,
          image_url: session.includeImage ? session.pendingImageUrl : undefined,
        });

        if (!headlineRes.ok) {
          const err = await headlineRes.json();
          throw new Error(err.error || "Failed to create headline");
        }

        const { headline } = await headlineRes.json();
        const articleUrl = `/article/${headline.id}`;

        // 2. Update coin_of_the_day pointer to the article page
        await apiRequest("/coin-of-the-day", "PUT", {
          title: cotdTitle,
          url: articleUrl,
          description,
          image_url: session.includeImage ? session.pendingImageUrl : undefined,
        });

        // 3. AI enrichment — importance score + McAfee take + full summary (non-blocking)
        const pageContent = session.pendingPageContent || {
          title: session.pendingTitle || "",
          description: description || "",
          content: "",
          imageUrl: null,
        };
        const headlineId = headline.id;

        Promise.all([
          scoreHeadlineImportance(cotdTitle, pageContent),
          generateMcAfeeTake(cotdTitle, pageContent, true),
          generateCoinSummary(cotdTitle, pageContent),
        ]).then(([importanceScore, mcafeeTake, summary]) => {
          updateHeadlineImportanceScore(headlineId, importanceScore);
          updateHeadlineMcAfeeTake(headlineId, mcafeeTake);
          updateHeadlineSummary(headlineId, summary);
          console.log(`[COTD] AI enrichment for #${headlineId}: importance=${importanceScore}, summary=${summary.length} chars`);
        }).catch(err => {
          console.warn(`[COTD] AI enrichment failed (non-fatal):`, err);
        });

        await ctx.reply(
          `*Coin of the Day published*\n` +
          `─────────────────────\n\n` +
          `Title: ${escapeMarkdown(cotdTitle)}\n` +
          `Article: \`${API_URL}${articleUrl}\`\n` +
          `Source: \`${session.pendingUrl || ""}\`\n` +
          `${description ? `Description: ${escapeMarkdown(description)}\n` : ""}` +
          `${session.includeImage ? "Image: included\n" : ""}` +
          `\n_Published as article — no token created._\n` +
          `_AI summary generating..._`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        console.error("Error setting coin of the day:", error);
        await ctx.reply("Failed to set Coin of the Day. Try again.");
      }

      resetSession(session);
      break;
    }

    default:
      break;
  }
});

// ============================================================
//  CALLBACK QUERIES (button clicks)
// ============================================================

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const session = ctx.session;

  // Meme-ify choice — part of public submission flow, no auth required
  if ((data === "memeify_yes" || data === "memeify_no") && session.step === "awaiting_memeify_choice") {
    session.pendingMemeifyImage = data === "memeify_yes";
    const label = data === "memeify_yes" ? "Meme-ified" : "As-is";
    await ctx.editMessageText(`Image style: ${label}`);
    await ctx.answerCallbackQuery();
    await finalizeSubmission(ctx, ctx.from!.id, session);
    return;
  }

  if (!ctx.from || !isAuthorized(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Not authorized." });
    return;
  }

  // Headline selection (regular)
  if (data.startsWith("headline_")) {
    if (data === "headline_custom") {
      await ctx.editMessageText("Type your headline:");
      await ctx.answerCallbackQuery();
      return;
    }

    const index = parseInt(data.replace("headline_", ""), 10);
    const selectedHeadline = session.generatedHeadlines?.[index];

    if (selectedHeadline) {
      session.pendingTitle = selectedHeadline;

      if (session.pendingImageUrl) {
        session.step = "awaiting_image_choice";

        const keyboard = new InlineKeyboard()
          .text("Yes", "image_yes")
          .text("No", "image_no");

        await ctx.editMessageText(
          `Selected: "${selectedHeadline}"\n\nInclude thumbnail?`,
          { reply_markup: keyboard }
        );
      } else {
        session.step = "awaiting_column";

        const keyboard = new InlineKeyboard()
          .text("Left", "column_left")
          .text("Right", "column_right");

        await ctx.editMessageText(
          `Selected: "${selectedHeadline}"\n\nColumn:`,
          { reply_markup: keyboard }
        );
      }
    }
    await ctx.answerCallbackQuery();
    return;
  }

  // Image choice (regular)
  if (data === "image_yes" || data === "image_no") {
    session.includeImage = data === "image_yes";
    session.step = "awaiting_column";

    const keyboard = new InlineKeyboard()
      .text("Left", "column_left")
      .text("Right", "column_right");

    await ctx.editMessageText(
      `${data === "image_yes" ? "Image included." : "No image."}\n\n"${session.pendingTitle}"\n\nColumn:`,
      { reply_markup: keyboard }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // Main headline selection
  if (data.startsWith("main_headline_")) {
    if (data === "main_headline_custom") {
      await ctx.editMessageText("Type your headline:");
      await ctx.answerCallbackQuery();
      return;
    }

    const index = parseInt(data.replace("main_headline_", ""), 10);
    const selectedHeadline = session.generatedHeadlines?.[index];

    if (selectedHeadline) {
      session.pendingTitle = selectedHeadline;

      if (session.pendingImageUrl) {
        session.step = "awaiting_main_image_choice";

        const keyboard = new InlineKeyboard()
          .text("Yes", "main_image_yes")
          .text("No", "main_image_no");

        await ctx.editMessageText(
          `Selected: "${selectedHeadline}"\n\nInclude thumbnail?`,
          { reply_markup: keyboard }
        );
      } else {
        session.step = "awaiting_main_subtitle";
        await ctx.editMessageText(
          `Selected: "${selectedHeadline}"\n\nSend a subtitle (or /skip):`
        );
      }
    }
    await ctx.answerCallbackQuery();
    return;
  }

  // Main image choice
  if (data === "main_image_yes" || data === "main_image_no") {
    session.includeImage = data === "main_image_yes";
    session.step = "awaiting_main_subtitle";

    await ctx.editMessageText(
      `${data === "main_image_yes" ? "Image included." : "No image."}\n\n"${session.pendingTitle}"\n\nSend a subtitle (or /skip):`
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // COTD headline selection
  if (data.startsWith("cotd_headline_")) {
    if (data === "cotd_headline_custom") {
      await ctx.editMessageText("Type your title:");
      await ctx.answerCallbackQuery();
      return;
    }

    const index = parseInt(data.replace("cotd_headline_", ""), 10);
    const selectedHeadline = session.generatedHeadlines?.[index];

    if (selectedHeadline) {
      session.pendingTitle = selectedHeadline;

      if (session.pendingImageUrl) {
        session.step = "awaiting_cotd_image_choice";

        const keyboard = new InlineKeyboard()
          .text("Yes", "cotd_image_yes")
          .text("No", "cotd_image_no");

        await ctx.editMessageText(
          `Selected: "${selectedHeadline}"\n\nInclude project image?`,
          { reply_markup: keyboard }
        );
      } else {
        session.step = "awaiting_cotd_description";
        await ctx.editMessageText(
          `Selected: "${selectedHeadline}"\n\nSend a short description (or /skip):`
        );
      }
    }
    await ctx.answerCallbackQuery();
    return;
  }

  // COTD image choice
  if (data === "cotd_image_yes" || data === "cotd_image_no") {
    session.includeImage = data === "cotd_image_yes";
    session.step = "awaiting_cotd_description";

    await ctx.editMessageText(
      `${data === "cotd_image_yes" ? "Image included." : "No image."}\n\n"${session.pendingTitle}"\n\nSend a short description (or /skip):`
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // Column selection
  if (session.step === "awaiting_column" && (data === "column_left" || data === "column_right")) {
    const column = data === "column_left" ? "left" : "right";

    try {
      const response = await apiRequest("/headlines", "POST", {
        title: session.pendingTitle,
        url: session.pendingUrl,
        column,
        image_url: session.includeImage ? session.pendingImageUrl : undefined,
      });

      if (response.ok) {
        const result = await response.json();
        const colLabel = column === "left" ? "Left" : "Right";

        await ctx.editMessageText(
          `*Headline added — ${colLabel} column*\n` +
          `─────────────────────\n\n` +
          `${escapeMarkdown(session.pendingTitle || "")}\n` +
          `URL: \`${session.pendingUrl || ""}\`\n` +
          `${session.includeImage ? "Image: included\n" : ""}` +
          `ID: \`${result.headline.id}\`\n` +
          `\n${API_URL}`,
          { parse_mode: "Markdown" }
        );
      } else {
        const error = await response.json();
        throw new Error(error.error || "Unknown error");
      }
    } catch (error) {
      console.error("Error adding headline:", error);
      await ctx.editMessageText("Failed to add headline. Try again.");
    }

    resetSession(session);
  }

  await ctx.answerCallbackQuery();
});

// Error handler
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Graceful shutdown handling
let isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    console.log(`[Bot] Already shutting down, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down...`);

  try {
    await bot.stop();
    console.log("Bot stopped.");
  } catch (error) {
    console.error("Error stopping bot:", error);
  }

  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);
  await gracefulShutdown("uncaughtException");
});

process.on("unhandledRejection", async (reason) => {
  console.error("Unhandled rejection:", reason);
});

// Start the bot
console.log("Starting bot...");
bot.start({
  onStart: (botInfo) => {
    console.log(`Bot started: @${botInfo.username}`);
    console.log(`API: ${API_URL}`);
    console.log(`Admins: ${ADMIN_IDS.join(", ") || "none"}`);

    if (process.send) {
      process.send("ready");
    }
  },
});
