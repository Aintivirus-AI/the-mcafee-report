import { NextRequest, NextResponse } from "next/server";
import {
  getHeadlines,
  getAllHeadlines,
  addHeadline,
  removeHeadline,
} from "@/lib/db";
import { isAuthenticated } from "@/lib/auth";
import type { AddHeadlineRequest } from "@/lib/types";

/**
 * GET /api/headlines
 * Query params:
 *   - column: 'left' | 'right' | 'center' | 'all' (default: 'all')
 *   - limit: number (default: 25)
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const column = searchParams.get("column") || "all";
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "25", 10), 1), 200);

    if (column === "all") {
      const headlines = getAllHeadlines(limit);
      return NextResponse.json({ headlines });
    }

    if (!["left", "right", "center"].includes(column)) {
      return NextResponse.json(
        { error: "Invalid column. Must be 'left', 'right', 'center', or 'all'" },
        { status: 400 }
      );
    }

    const headlines = getHeadlines(column as "left" | "right" | "center", limit);
    return NextResponse.json({ headlines });
  } catch (error) {
    console.error("Error fetching headlines:", error);
    return NextResponse.json(
      { error: "Failed to fetch headlines" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/headlines
 * Body: { title: string, url: string, column?: 'left' | 'right' }
 * Requires x-api-key header
 */
export async function POST(request: NextRequest) {
  try {
    // Check authorization (timing-safe comparison)
    if (!isAuthenticated(request)) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body: AddHeadlineRequest = await request.json();

    // Validate required fields
    if (!body.title || !body.url) {
      return NextResponse.json(
        { error: "Missing required fields: title and url" },
        { status: 400 }
      );
    }

    // Validate column if provided
    const column = body.column || "left";
    if (!["left", "right"].includes(column)) {
      return NextResponse.json(
        { error: "Invalid column. Must be 'left' or 'right'" },
        { status: 400 }
      );
    }

    // Add headline
    const headline = addHeadline(body.title, body.url, column, body.image_url);

    return NextResponse.json({ headline }, { status: 201 });
  } catch (error) {
    console.error("Error adding headline:", error);
    return NextResponse.json(
      { error: "Failed to add headline" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/headlines
 * Query params: id (required)
 * Requires x-api-key header
 */
export async function DELETE(request: NextRequest) {
  try {
    // Check authorization (timing-safe comparison)
    if (!isAuthenticated(request)) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const searchParams = request.nextUrl.searchParams;
    const idParam = searchParams.get("id");

    if (!idParam) {
      return NextResponse.json(
        { error: "Missing required parameter: id" },
        { status: 400 }
      );
    }

    const id = parseInt(idParam, 10);
    if (isNaN(id)) {
      return NextResponse.json(
        { error: "Invalid id parameter" },
        { status: 400 }
      );
    }

    const deleted = removeHeadline(id);

    if (!deleted) {
      return NextResponse.json(
        { error: "Headline not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting headline:", error);
    return NextResponse.json(
      { error: "Failed to delete headline" },
      { status: 500 }
    );
  }
}
