"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface Comment {
  id: number;
  headline_id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  telegram_first_name: string | null;
  content: string;
  created_at: string;
}

interface TelegramAuthData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

// Extend window for Telegram callback
declare global {
  interface Window {
    onTelegramAuth?: (user: TelegramAuthData) => void;
  }
}

const BOT_NAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_NAME || "mcafeereport_bot";

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function CommentSection({ headlineId }: { headlineId: number }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [user, setUser] = useState<TelegramAuthData | null>(null);
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loginRef = useRef<HTMLDivElement>(null);

  // Fetch comments
  const fetchComments = useCallback(async () => {
    try {
      const res = await fetch(`/api/comments?headline_id=${headlineId}`);
      const data = await res.json();
      if (data.comments) setComments(data.comments);
    } catch {
      // Silent fail
    }
  }, [headlineId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  // Restore auth from sessionStorage
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("tg_auth");
      if (saved) setUser(JSON.parse(saved));
    } catch {
      // Ignore
    }
  }, []);

  // Set up Telegram Login Widget callback
  useEffect(() => {
    window.onTelegramAuth = (authUser: TelegramAuthData) => {
      setUser(authUser);
      try {
        sessionStorage.setItem("tg_auth", JSON.stringify(authUser));
      } catch {
        // Ignore
      }
    };
    return () => {
      delete window.onTelegramAuth;
    };
  }, []);

  // Load Telegram Login Widget script
  useEffect(() => {
    if (user || !loginRef.current) return;
    // Clear previous (avoid innerHTML to prevent XSS footgun)
    while (loginRef.current.firstChild) {
      loginRef.current.removeChild(loginRef.current.firstChild);
    }
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", BOT_NAME);
    script.setAttribute("data-size", "medium");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    script.setAttribute("data-request-access", "write");
    script.async = true;
    loginRef.current.appendChild(script);
  }, [user]);

  const handleSubmit = async () => {
    if (!user || !content.trim()) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headline_id: headlineId,
          content: content.trim(),
          auth: user,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Failed to post comment");
        return;
      }

      setContent("");
      await fetchComments();
    } catch {
      setError("Failed to post comment");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t border-dark-200/30 pt-8 mb-8">
      <h2 className="text-lg font-bold text-white mb-4 tracking-wide flex items-center gap-2">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5 text-neon-cyan">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        COMMENTS {comments.length > 0 && <span className="text-sm text-gray-500 font-normal">({comments.length})</span>}
      </h2>

      {/* Comment form or login */}
      <div className="mb-6">
        {user ? (
          <div>
            <div className="flex items-center gap-2 mb-2 text-sm text-gray-400">
              <span className="text-neon-cyan font-medium">
                {user.username ? `@${user.username}` : user.first_name}
              </span>
              <button
                onClick={() => {
                  setUser(null);
                  sessionStorage.removeItem("tg_auth");
                }}
                className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
              >
                (sign out)
              </button>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !submitting && handleSubmit()}
                placeholder="Add a comment..."
                maxLength={1000}
                className="flex-1 bg-dark-100/50 border border-dark-200/30 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-neon-cyan/50 transition-colors"
              />
              <button
                onClick={handleSubmit}
                disabled={submitting || !content.trim()}
                className="px-4 py-2 rounded-lg bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan text-sm font-medium hover:bg-neon-cyan/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {submitting ? "..." : "Post"}
              </button>
            </div>
            {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">Sign in to comment:</span>
            <div ref={loginRef} />
          </div>
        )}
      </div>

      {/* Comment list */}
      {comments.length === 0 ? (
        <p className="text-gray-600 text-sm text-center py-4">No comments yet. Be the first!</p>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => (
            <div
              key={c.id}
              className="p-3 rounded-lg bg-dark-100/30 border border-dark-200/20"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm font-medium text-neon-cyan">
                  {c.telegram_username ? `@${c.telegram_username}` : c.telegram_first_name || "Anon"}
                </span>
                <span className="text-xs text-gray-600">{timeAgo(c.created_at)}</span>
              </div>
              <p className="text-sm text-gray-300 leading-relaxed">{c.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
