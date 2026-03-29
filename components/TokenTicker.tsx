"use client";

import { useState, useRef, useEffect } from "react";
import { EarnModal } from "./EarnModal";

const CA = "7Epmyp9dMD5SzUtxczbuWwsVARyWdzLFAkzxnvZWpump";
const PUMP_URL = `https://pump.fun/coin/${CA}`;

export function TokenTicker() {
  const [copied, setCopied] = useState(false);
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

  const handleCopy = () => {
    navigator.clipboard?.writeText(CA)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard permission denied — fail silently
      });
  };

  return (
    <div className="token-ticker">
      {/* $NEWS address pill with quick links */}
      <div className="token-ticker-inner">
        <a
          href={PUMP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="token-ticker-badge"
        >
          <img
            src="/mcafee-logo.png"
            alt="McAfee Report"
            className="token-ticker-logo"
          />
          $NEWS
        </a>
        {/* CA + copy button hidden for now
        <span className="token-ticker-ca">
          {CA.slice(0, 6)}...{CA.slice(-4)}
        </span>
        <button
          onClick={handleCopy}
          className="token-ticker-copy"
          title="Copy contract address"
        >
          {copied ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3.5 h-3.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          )}
        </button>
        */}

        <span className="token-ticker-divider" />

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
