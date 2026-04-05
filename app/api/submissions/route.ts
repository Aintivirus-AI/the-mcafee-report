import { NextRequest, NextResponse } from "next/server";
import {
  getSubmissionsByStatus,
  getSubmissionById,
  updateSubmissionStatus,
  getPendingSubmissionsCount,
  getPublishedTodayCount,
} from "@/lib/db";
import { VALID_STATUS_TRANSITIONS } from "@/lib/types";
import type { SubmissionStatus } from "@/lib/types";
import { isAuthenticated, clampInt } from "@/lib/auth";

/**
 * GET /api/submissions
 * Get submissions with optional filters
 * 
 * Query params:
 * - status: filter by status (pending, validating, approved, rejected, published)
 * - limit: max results (default 50, max 200)
 */
export async function GET(request: NextRequest) {
  if (!isAuthenticated(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const status = searchParams.get("status") as "pending" | "validating" | "approved" | "rejected" | "published" | null;
    const limit = clampInt(parseInt(searchParams.get("limit") || "50", 10), 1, 200);

    let submissions;
    if (status) {
      submissions = getSubmissionsByStatus(status, limit);
    } else {
      // Get all statuses
      const pending = getSubmissionsByStatus("pending", limit);
      const validating = getSubmissionsByStatus("validating", limit);
      const approved = getSubmissionsByStatus("approved", limit);
      submissions = [...pending, ...validating, ...approved].slice(0, limit);
    }

    // Get stats
    const stats = {
      pendingCount: getPendingSubmissionsCount(),
      publishedToday: getPublishedTodayCount(),
    };

    return NextResponse.json({
      success: true,
      data: submissions,
      stats,
    });
  } catch (error) {
    console.error("Error fetching submissions:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch submissions" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/submissions
 * Update a submission's status (was POST — PATCH is semantically correct for updates)
 * 
 * Body:
 * - id: submission ID
 * - status: new status
 * - rejectionReason: optional reason for rejection
 */
export async function PATCH(request: NextRequest) {
  if (!isAuthenticated(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { id, status, rejectionReason } = body;

    if (!Number.isInteger(id) || id <= 0 || !status) {
      return NextResponse.json(
        { success: false, error: "id must be a positive integer and status is required" },
        { status: 400 }
      );
    }

    // Validate status
    const validStatuses = ["pending", "validating", "approved", "rejected", "published"];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { success: false, error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }

    // Input length validation
    if (rejectionReason && rejectionReason.length > 1000) {
      return NextResponse.json(
        { success: false, error: "rejectionReason must be 1000 characters or less" },
        { status: 400 }
      );
    }

    // Get current submission
    const submission = getSubmissionById(id);
    if (!submission) {
      return NextResponse.json(
        { success: false, error: "Submission not found" },
        { status: 404 }
      );
    }

    // Enforce state machine transitions
    const currentStatus = submission.status as SubmissionStatus;
    const validTransitions = VALID_STATUS_TRANSITIONS[currentStatus] || [];
    if (!validTransitions.includes(status as SubmissionStatus)) {
      return NextResponse.json(
        { success: false, error: "Invalid status transition" },
        { status: 400 }
      );
    }

    // Update status
    const updated = updateSubmissionStatus(id, status, rejectionReason);

    if (updated) {
      return NextResponse.json({
        success: true,
        message: `Submission #${id} status updated to ${status}`,
      });
    } else {
      return NextResponse.json(
        { success: false, error: "Failed to update submission (concurrent modification)" },
        { status: 409 }
      );
    }
  } catch (error) {
    console.error("Error updating submission:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update submission" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/submissions — backwards compatibility alias for PATCH
 */
export async function POST(request: NextRequest) {
  return PATCH(request);
}
