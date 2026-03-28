/**
 * Dynamic OG Share Card Generator.
 *
 * Generates cinematic 1200x630 share images for each article using
 * Next.js ImageResponse (next/og). No additional dependencies needed.
 */

import { ImageResponse } from "next/og";
import { getHeadlineWithDetails, getVoteCounts } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const headlineId = parseInt(id, 10);

  if (isNaN(headlineId) || headlineId <= 0) {
    return new Response("Invalid ID", { status: 400 });
  }

  const article = getHeadlineWithDetails(headlineId);
  if (!article) {
    return new Response("Not found", { status: 404 });
  }

  const votes = getVoteCounts(headlineId);
  const totalVotes = votes.wagmi + votes.ngmi;
  const wagmiPercent = totalVotes > 0 ? Math.round((votes.wagmi / totalVotes) * 100) : 50;

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "60px",
          background: "linear-gradient(135deg, #05050a 0%, #0c0c14 50%, #0a0a1a 100%)",
          fontFamily: "system-ui, -apple-system, sans-serif",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Grid background effect */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundImage:
              "linear-gradient(rgba(0, 211, 255, 0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(0, 211, 255, 0.04) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
            display: "flex",
          }}
        />

        {/* Accent glow */}
        <div
          style={{
            position: "absolute",
            top: "-100px",
            right: "-100px",
            width: "400px",
            height: "400px",
            background: "radial-gradient(circle, rgba(0, 211, 255, 0.15) 0%, transparent 70%)",
            borderRadius: "50%",
            display: "flex",
          }}
        />

        {/* Top section: Branding + Token */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            zIndex: 1,
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                fontSize: "24px",
                fontWeight: 800,
                color: "#00D3FF",
                letterSpacing: "4px",
                display: "flex",
              }}
            >
              THE MCAFEE REPORT
            </div>
            <div
              style={{
                fontSize: "14px",
                color: "rgba(156, 163, 175, 0.7)",
                letterSpacing: "2px",
                marginTop: "4px",
                display: "flex",
              }}
            >
              Powered by AintiVirus
            </div>
          </div>

          {/* Token badge */}
          {article.token && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "12px 20px",
                borderRadius: "12px",
                border: "1px solid rgba(0, 211, 255, 0.3)",
                background: "rgba(0, 211, 255, 0.08)",
              }}
            >
              <div
                style={{
                  fontSize: "20px",
                  fontWeight: 700,
                  color: "#00D3FF",
                  display: "flex",
                }}
              >
                ${article.token.ticker}
              </div>
            </div>
          )}
        </div>

        {/* Center: Headline */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            zIndex: 1,
            flex: 1,
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontSize: article.title.length > 80 ? "36px" : article.title.length > 50 ? "42px" : "48px",
              fontWeight: 800,
              color: "#ef4444",
              lineHeight: 1.15,
              display: "flex",
              maxHeight: "240px",
              overflow: "hidden",
            }}
          >
            {article.title.length > 120 ? article.title.slice(0, 117) + "..." : article.title}
          </div>

          {/* McAfee take */}
          {article.mcafee_take && (
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "10px",
                marginTop: "8px",
              }}
            >
              <div
                style={{
                  fontSize: "18px",
                  display: "flex",
                }}
              >
                👻
              </div>
              <div
                style={{
                  fontSize: "18px",
                  color: "rgba(191, 90, 242, 0.9)",
                  fontStyle: "italic",
                  lineHeight: 1.4,
                  display: "flex",
                  maxHeight: "80px",
                  overflow: "hidden",
                }}
              >
                {article.mcafee_take.length > 120
                  ? article.mcafee_take.slice(0, 117) + "..."
                  : article.mcafee_take}
              </div>
            </div>
          )}
        </div>

        {/* Bottom: Sentiment + CTA */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            zIndex: 1,
          }}
        >
          {/* Sentiment bar */}
          {totalVotes > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div
                style={{
                  fontSize: "12px",
                  color: "rgba(156, 163, 175, 0.6)",
                  letterSpacing: "2px",
                  display: "flex",
                }}
              >
                COMMUNITY SENTIMENT
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                }}
              >
                <div
                  style={{
                    fontSize: "16px",
                    fontWeight: 700,
                    color: "#00ff9d",
                    display: "flex",
                  }}
                >
                  WAGMI {wagmiPercent}%
                </div>
                <div
                  style={{
                    width: "200px",
                    height: "8px",
                    borderRadius: "4px",
                    background: "rgba(255, 255, 255, 0.1)",
                    display: "flex",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${wagmiPercent}%`,
                      height: "100%",
                      background: "linear-gradient(90deg, #00ff9d, #00D3FF)",
                      borderRadius: "4px",
                      display: "flex",
                    }}
                  />
                </div>
                <div
                  style={{
                    fontSize: "16px",
                    fontWeight: 700,
                    color: "#ef4444",
                    display: "flex",
                  }}
                >
                  NGMI {100 - wagmiPercent}%
                </div>
              </div>
            </div>
          )}

          {/* Bottom right: neon line accent */}
          <div
            style={{
              width: "80px",
              height: "3px",
              background: "linear-gradient(90deg, #00D3FF, #bf5af2)",
              borderRadius: "2px",
              display: "flex",
            }}
          />
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  );
}
