"use client";

import { useState, useRef, useEffect } from "react";
import { EarnModal } from "./EarnModal";

export function TokenTicker() {
  const [earnOpen, setEarnOpen] = useState(false);
  const [cotdUrl, setCotdUrl] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Fetch coin of the day URL
  useEffect(() => {
    fetch("/api/coin-of-the-day")
      .then(res => res.json())
      .then(data => {
        if (data.coinOfTheDay?.url) {
          setCotdUrl(data.coinOfTheDay.url);
        }
      })
      .catch((err) => console.warn('[TokenTicker] fetch failed:', err));
  }, []);

  return (
    <div className="token-ticker">
      <div className="token-ticker-inner">
        <a href="/analytics" className="token-ticker-link token-ticker-link--gold" title="Analytics">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3.5 h-3.5">
            <path d="M18 20V10M12 20V4M6 20v-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Analytics
        </a>

        <span className="token-ticker-divider" />

        <button
          onClick={() => setEarnOpen(true)}
          className="token-ticker-link token-ticker-link--rainbow"
        >
          Earn Now
        </button>

        {cotdUrl && (
          <>
            <span className="token-ticker-divider" />
            <a
              href={cotdUrl}
              className="token-ticker-link token-ticker-link--cotd"
              title="Coin of the Day"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="token-ticker-cotd-text">Coin of the Day</span>
              <span className="token-ticker-cotd-short">COTD</span>
            </a>
          </>
        )}
      </div>

      <EarnModal open={earnOpen} onClose={() => setEarnOpen(false)} />
    </div>
  );
}
