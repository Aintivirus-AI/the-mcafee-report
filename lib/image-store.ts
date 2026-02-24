/**
 * Persistent image storage for token images.
 * Handles both direct buffer saves (from gpt-image-1 base64) and
 * URL downloads (legacy DALL-E temporary URLs, external images).
 * Images are saved to the public directory and served as static assets.
 *
 * Security:
 * - SVG files are rejected (can contain <script> tags = stored XSS)
 * - File size is capped at 10 MB
 * - Downloads use safeFetch for SSRF protection
 * - File count is monitored
 */

import path from "path";
import fs from "fs";
import crypto from "crypto";
import OpenAI from "openai";
import { safeFetch } from "./url-validator";

const IMAGE_DIR = path.join(process.cwd(), "public", "tokens");
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_FILES_IN_DIR = 5000; // Safety limit

// Ensure directory exists on module load
if (!fs.existsSync(IMAGE_DIR)) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

/**
 * Save a raw image buffer directly to permanent storage.
 * Used by the token image generator after receiving base64 from gpt-image-1.
 * Returns the public URL path (e.g. "/tokens/fed-rate-cut-abc123def456.png").
 */
export function saveImageBuffer(buffer: Buffer, identifier: string): string {
  // Validate file size
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large: ${buffer.length} bytes (max ${MAX_IMAGE_BYTES})`);
  }

  // Validate it's actually a raster image (NO SVG — XSS risk)
  if (!isValidRasterImage(buffer)) {
    throw new Error("Invalid image format — only PNG, JPEG, GIF, and WebP are allowed");
  }

  // Check file count limit
  try {
    const fileCount = fs.readdirSync(IMAGE_DIR).length;
    if (fileCount >= MAX_FILES_IN_DIR) {
      console.warn(`[ImageStore] Directory has ${fileCount} files, approaching limit`);
    }
  } catch {
    // Non-critical, continue
  }

  const hash = crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex")
    .substring(0, 12);
  const safeId = identifier.toLowerCase().replace(/[^a-z0-9-]/g, "").substring(0, 30) || "token";
  const filename = `${safeId}-${hash}.png`;
  const filepath = path.join(IMAGE_DIR, filename);

  // Don't re-write if exact same file already exists
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, buffer);
    console.log(
      `[ImageStore] Saved image buffer: ${filename} (${buffer.length} bytes)`
    );
  }

  return `/tokens/${filename}`;
}

/**
 * Persist an image to permanent storage.
 * - If imageUrl is already a local /tokens/ path, returns it as-is (already persisted).
 * - If imageUrl is an HTTP URL, downloads and saves it permanently.
 * Returns the public URL path (e.g. "/tokens/btc-abc123def456.png").
 */
export async function persistImage(
  imageUrl: string,
  ticker: string
): Promise<string> {
  // Already a local path — image was saved directly by the generator
  if (imageUrl.startsWith("/tokens/")) {
    console.log(`[ImageStore] Image already persisted: ${imageUrl}`);
    return imageUrl;
  }

  try {
    // Download with SSRF protection and timeout
    const response = await safeFetch(imageUrl, {
      timeoutMs: 30_000,
      maxBytes: MAX_IMAGE_BYTES,
      // Only skip SSRF for known-safe hosts
      skipSsrfCheck: imageUrl.includes("oaidalleapiprodscus.blob.core.windows.net") ||
                     imageUrl.includes("api.dicebear.com"),
    });

    if (!response.ok) {
      throw new Error(`Failed to download image: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Validate that it is actually a raster image
    if (!isValidRasterImage(buffer)) {
      throw new Error("Downloaded content is not a valid raster image (SVG is not allowed)");
    }

    const safeTicker = ticker.toLowerCase().replace(/[^a-z0-9]/g, "") || "token";
    return saveImageBuffer(buffer, safeTicker);
  } catch (error) {
    console.error("[ImageStore] Failed to persist image:", error);
    // Return the original URL as fallback (may expire for DALL-E URLs)
    return imageUrl;
  }
}

/**
 * Check if a buffer contains valid RASTER image data (PNG, JPEG, GIF, WebP).
 * SVG is explicitly rejected because it can contain JavaScript (stored XSS).
 */
export function isValidRasterImage(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;

  // PNG: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return true;
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  // GIF: 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return true;
  }
  // WebP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length > 11 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return true;
  }

  // SVG explicitly REJECTED (starts with < and contains <svg)
  // SVG files can contain <script> tags and other XSS payloads
  if (buffer[0] === 0x3c) {
    return false; // Any XML-like content is rejected
  }

  return false;
}

/**
 * Get the full public URL for a token image path.
 */
export function getImagePublicUrl(imagePath: string): string {
  if (imagePath.startsWith("http")) return imagePath;
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  return `${siteUrl}${imagePath}`;
}

/**
 * Screen an image for policy violations using OpenAI's omni-moderation model.
 * Catches sexual content, violence/gore, self-harm, hate symbols, etc.
 */
export async function moderateImage(imageBase64: string): Promise<{
  safe: boolean;
  flaggedCategories: string[];
}> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const result = await openai.moderations.create({
    model: "omni-moderation-latest",
    input: [
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${imageBase64}` },
      },
    ],
  });

  const modResult = result.results[0];
  const flaggedCategories = Object.entries(modResult.categories)
    .filter(([, v]) => v)
    .map(([k]) => k);

  return { safe: !modResult.flagged, flaggedCategories };
}
