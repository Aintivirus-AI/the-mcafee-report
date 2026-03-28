import { describe, it, expect, vi } from "vitest";

// Mock the db module so no real DB is needed
vi.mock("@/lib/db", () => ({
  getActivityLog: vi.fn(() => []),
  getActivityStats: vi.fn(() => ({})),
}));

import { GET } from "./route";

function makeRequest(search: string): Request {
  return new Request(`http://localhost/api/war-room${search}`);
}

describe("GET /api/war-room — afterId validation", () => {
  it("accepts a valid afterId", async () => {
    const res = await GET(makeRequest("?after=10") as any);
    expect(res.status).toBe(200);
  });

  it("returns 400 for negative afterId", async () => {
    const res = await GET(makeRequest("?after=-1") as any);
    expect(res.status).toBe(400);
  });

  it("returns 400 for afterId = 0", async () => {
    const res = await GET(makeRequest("?after=0") as any);
    expect(res.status).toBe(400);
  });

  it("returns 400 for afterId exceeding INT32 max", async () => {
    const res = await GET(makeRequest("?after=2147483648") as any);
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-numeric afterId", async () => {
    const res = await GET(makeRequest("?after=abc") as any);
    expect(res.status).toBe(400);
  });

  it("returns 200 when no afterId is provided", async () => {
    const res = await GET(makeRequest("") as any);
    expect(res.status).toBe(200);
  });
});
