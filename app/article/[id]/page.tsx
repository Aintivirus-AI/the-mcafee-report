import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getHeadlineWithDetails, getRelatedHeadlines } from "@/lib/db";
import { TokenBadge } from "@/components/TokenBadge";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { CopyAddressButton } from "@/components/CopyAddressButton";
import { ListenButton } from "@/components/ListenButton";
import { TimeAgo } from "@/components/TimeAgo";
import { McAfeeCommentary } from "@/components/McAfeeCommentary";
import { VoteButtons } from "@/components/VoteButtons";
import { SubmitCTA } from "@/components/SubmitCTA";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArticleChat } from "@/components/ArticleChat";
import { CommentSection } from "@/components/CommentSection";

export const revalidate = 30;

interface ArticlePageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: ArticlePageProps): Promise<Metadata> {
  const { id } = await params;
  const article = getHeadlineWithDetails(parseInt(id, 10));
  if (!article) return { title: "Article Not Found" };

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const ogImageUrl = `${siteUrl}/api/og/${id}`;

  const description = article.token
    ? `$${article.token.ticker} token launched for this story. Trade on pump.fun. Powered by The McAfee Report.`
    : "Breaking news on The McAfee Report. Powered by AintiVirus.";

  const articleUrl = `${siteUrl}/article/${id}`;

  return {
    title: `${article.title} | The McAfee Report`,
    description,
    alternates: {
      canonical: articleUrl,
    },
    openGraph: {
      title: article.title,
      description,
      url: articleUrl,
      siteName: "The McAfee Report",
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: article.title }],
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      site: "@officialmcafee",
      title: article.title,
      description,
      images: [{ url: ogImageUrl, alt: article.title }],
    },
  };
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { id } = await params;
  const article = getHeadlineWithDetails(parseInt(id, 10));
  if (!article) notFound();

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const articleUrl = `${siteUrl}/article/${article.id}`;
  const articleUrlX = `${articleUrl}?utm_source=mcafee_report&utm_medium=x&utm_campaign=article_share`;
  const articleUrlTg = `${articleUrl}?utm_source=mcafee_report&utm_medium=telegram&utm_campaign=article_share`;
  const tweetLines = [article.title];
  if (article.token?.ticker && article.token?.pump_url) {
    tweetLines.push(`\n$${article.token.ticker} just launched\n${article.token.pump_url}`);
  } else if (article.token?.ticker) {
    tweetLines.push(`\n$${article.token.ticker}`);
  }
  tweetLines.push(`\n${articleUrlX}`);
  const tweetText = encodeURIComponent(tweetLines.join(""));
  // Telegram text without URL (the url param handles it, avoids double-link)
  const tgLines = [article.title];
  if (article.token?.ticker && article.token?.pump_url) {
    tgLines.push(`\n$${article.token.ticker} just launched\n${article.token.pump_url}`);
  } else if (article.token?.ticker) {
    tgLines.push(`\n$${article.token.ticker}`);
  }
  const tgText = encodeURIComponent(tgLines.join(""));
  const telegramShareUrl = encodeURIComponent(articleUrlTg);

  const publishedDate = new Date(article.created_at);

  // Extract summary for both the Summary box and the chatbot context
  let articleSummary: string | null = article.summary || null;
  if (!articleSummary && article.cached_content) {
    try {
      const parsed = JSON.parse(article.cached_content);
      articleSummary = parsed.description || (parsed.content ? parsed.content.slice(0, 500) : null);
    } catch {
      // Invalid JSON — skip
    }
  }

  // NewsArticle JSON-LD for rich search results
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: article.title,
    url: articleUrl,
    datePublished: article.created_at,
    dateModified: article.created_at,
    image: article.image_url ? [article.image_url] : undefined,
    description: articleSummary || article.title,
    publisher: {
      "@type": "Organization",
      name: "The McAfee Report",
      logo: { "@type": "ImageObject", url: `${siteUrl}/mcafee-logo.png` },
    },
    mainEntityOfPage: { "@type": "WebPage", "@id": articleUrl },
  };

  return (
    <main className="main-content">
      {/* NewsArticle structured data */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\//g, '\\u002f') }} />

      <div className="min-h-screen grid-bg">
      {/* Header bar */}
      <div className="border-b border-dark-200/30 py-4">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between">
            <a href="/" className="text-neon-cyan hover:underline text-sm font-mono">
              &larr; Back to The McAfee Report
            </a>
            <div className="flex items-center gap-3">
              <TimeAgo date={article.created_at} />
              <ThemeToggle />
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8 max-w-6xl">
        {/* Hero image */}
        {article.image_url && (
          <div className="rounded-lg overflow-hidden border border-dark-200/30 mb-8">
            <img
              src={article.image_url}
              alt={article.title}
              className="w-full h-auto max-h-96 object-cover"
            />
          </div>
        )}

        {/* Headline — clickable link to source for regular articles */}
        {article.title.startsWith("Coin Of The Day:") ? (
          <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold text-red-500 leading-tight mb-4">
            {article.title}
          </h1>
        ) : (
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block group"
          >
            <h1 className="text-3xl md:text-4xl lg:text-5xl font-bold text-red-500 leading-tight mb-4 group-hover:underline decoration-red-500/50 underline-offset-4 transition-all">
              {article.title}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="inline-block w-6 h-6 md:w-8 md:h-8 ml-2 opacity-40 group-hover:opacity-100 transition-opacity align-baseline">
                <path d="M7 17L17 7M17 7H7M17 7v10" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </h1>
          </a>
        )}

        {/* AI McAfee Commentary */}
        {article.mcafee_take && (
          <div className="mb-6">
            <McAfeeCommentary take={article.mcafee_take} />
          </div>
        )}

        {/* WAGMI/NGMI Voting */}
        <div className="mb-6">
          <VoteButtons headlineId={article.id} headlineTitle={article.title} />
        </div>

        {/* Meta info */}
        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-400 mb-8">
          {article.submitter_wallet && (
            <span>Submitted by {article.submitter_wallet.slice(0, 4)}...{article.submitter_wallet.slice(-4)}</span>
          )}
          <span>{publishedDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-neon-cyan hover:underline"
          >
            Read source &rarr;
          </a>
        </div>

        {/* Article Summary + AI Chat Grid */}
        <div className="article-summary-chat-grid mb-8">
          {/* Left: Summary */}
          {articleSummary && (() => {
            const paragraphs = articleSummary.split(/\n\n+/).filter(Boolean);
            return (
              <div className="article-summary">
                <div className="article-summary-header">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 text-neon-cyan">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" strokeLinecap="round" strokeLinejoin="round"/>
                    <polyline points="14 2 14 8 20 8" strokeLinecap="round" strokeLinejoin="round"/>
                    <line x1="16" y1="13" x2="8" y2="13" strokeLinecap="round"/>
                    <line x1="16" y1="17" x2="8" y2="17" strokeLinecap="round"/>
                    <line x1="10" y1="9" x2="8" y2="9" strokeLinecap="round"/>
                  </svg>
                  <span className="text-sm font-semibold text-white tracking-wide">SUMMARY OF ARTICLE</span>
                  <ListenButton text={articleSummary} />
                </div>
                <div className="article-summary-text">
                  {paragraphs.map((p, i) => (
                    <p key={i} className={i < paragraphs.length - 1 ? "mb-4" : ""}>{p}</p>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Right: AI Chatbot */}
          <ArticleChat
            articleTitle={article.title}
            articleSummary={articleSummary || article.title}
          />
        </div>

        {/* Go to Project button — only for Coin of the Day articles */}
        {article.title.startsWith("Coin Of The Day:") && (
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 mb-8 rounded-lg bg-neon-cyan/10 border border-neon-cyan/30 hover:bg-neon-cyan/20 hover:border-neon-cyan/50 transition-all text-neon-cyan font-semibold text-sm"
          >
            Go to Project
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
              <path d="M7 17L17 7M17 7H7M17 7v10" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </a>
        )}

        {/* Token Section */}
        {article.token && (
          <div className="border border-neon-cyan/30 rounded-lg p-6 mb-8 bg-dark-100/50">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
              {/* Token image */}
              {article.token_image_url && (
                <img
                  src={article.token_image_url}
                  alt={article.token_name || article.token.ticker}
                  className="w-20 h-20 rounded-full border-2 border-neon-cyan/30"
                />
              )}

              <div className="flex-1">
                <h2 className="text-xl font-bold text-white">
                  {article.token_name || `$${article.token.ticker}`}
                </h2>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-gray-400 text-sm font-mono">
                    ${article.token.ticker}
                  </span>
                  {article.mint_address && (
                    <CopyAddressButton address={article.mint_address} />
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <TokenBadge
                  pumpUrl={article.token.pump_url}
                  ticker={article.token.ticker}
                  priceChange={article.token.price_change_24h}
                  size="md"
                />
              </div>
            </div>

            {/* DexScreener live chart */}
            {article.mint_address && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(article.mint_address) && (
              <div className="dexscreener-embed mt-6 rounded-lg overflow-hidden border border-dark-200/30">
                <iframe
                  src={`https://dexscreener.com/solana/${article.mint_address}?embed=1&theme=dark&info=0&chartLeftToolbar=0&chartTheme=dark`}
                  className="w-full border-0"
                  style={{ height: "600px" }}
                  title={`${article.token?.ticker || 'Token'} chart`}
                  loading="lazy"
                  allow="clipboard-write"
                />
                <a
                  href={`https://dexscreener.com/solana/${article.mint_address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dexscreener-link flex items-center justify-center gap-2 py-2.5 bg-black/40 hover:bg-black/60 transition-colors text-sm text-gray-400 hover:text-white"
                >
                  Open full chart on DexScreener
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3.5 h-3.5">
                    <path d="M7 17L17 7M17 7H7M17 7v10" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </a>
              </div>
            )}

            <p className="text-xs text-gray-500 mt-4 text-center">
              50% of creator fees go to the submitter. 50% buy and burn $NEWS.
            </p>
          </div>
        )}

        {/* Social Share */}
        <div className="flex flex-wrap justify-center gap-3 mb-8">
          <a
            href={`https://twitter.com/intent/tweet?text=${tweetText}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-dark-100 border border-dark-200/50 hover:border-white/30 transition-colors text-sm"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
            </svg>
            Share on X
          </a>
          <a
            href={`https://t.me/share/url?url=${telegramShareUrl}&text=${tgText}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-dark-100 border border-dark-200/50 hover:border-cyan-500/30 transition-colors text-sm"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
              <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
            </svg>
            Share on Telegram
          </a>
          <CopyLinkButton url={articleUrl} />
        </div>

        {/* Comments */}
        <CommentSection headlineId={article.id} />

        {/* Related Articles — prevents dead-end user journeys */}
        {(() => {
          const related = getRelatedHeadlines(article.id, 6);
          if (related.length === 0) return null;
          return (
            <div className="border-t border-dark-200/30 pt-8 mb-8">
              <h2 className="text-lg font-bold text-white mb-4 tracking-wide">YOU MIGHT ALSO LIKE</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {related.map((h) => (
                  <a
                    key={h.id}
                    href={`/article/${h.id}`}
                    className="block p-3 rounded-lg border border-dark-200/30 hover:border-neon-cyan/30 bg-dark-100/30 hover:bg-dark-100/60 transition-all group"
                  >
                    {h.image_url && (
                      <div className="rounded overflow-hidden mb-2 h-24">
                        <img
                          src={h.image_url}
                          alt=""
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                          loading="lazy"
                        />
                      </div>
                    )}
                    <h3 className="text-sm font-medium text-gray-200 group-hover:text-neon-cyan transition-colors leading-tight line-clamp-2">
                      {h.title}
                    </h3>
                    {h.token && (
                      <span className="inline-block mt-1 text-xs text-neon-cyan/70 font-mono">${h.token.ticker}</span>
                    )}
                  </a>
                ))}
              </div>
            </div>
          );
        })()}

        {/* How to Earn CTA */}
        <div className="border-t border-dark-200/30 pt-8">
          <SubmitCTA />
        </div>

        {/* Socials */}
        <div className="border-t border-dark-200/30 pt-8 pb-4">
          <div className="flex flex-wrap justify-center items-center gap-4">
            {/* Telegram */}
            <a
              href="https://t.me/AIntivirus"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-neon-cyan transition-colors"
              title="Telegram"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
              </svg>
              Telegram
            </a>

            <span className="text-dark-200/50 select-none" aria-hidden="true">|</span>

            {/* X (Twitter) */}
            <a
              href="https://x.com/TheMcAfeeReport"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-neon-cyan transition-colors"
              title="X"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              X
            </a>

            <span className="text-dark-200/50 select-none" aria-hidden="true">|</span>

            {/* GitHub */}
            <a
              href="https://github.com/aintivirus-AI"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-neon-cyan transition-colors"
              title="GitHub"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
              </svg>
              GitHub
            </a>

            <span className="text-dark-200/50 select-none" aria-hidden="true">|</span>

            {/* Medium */}
            <a
              href="https://medium.com/@themcafeereport"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-neon-cyan transition-colors"
              title="Medium"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path d="M13.54 12a6.8 6.8 0 0 1-6.77 6.82A6.8 6.8 0 0 1 0 12a6.8 6.8 0 0 1 6.77-6.82A6.8 6.8 0 0 1 13.54 12zm7.42 0c0 3.54-1.51 6.42-3.38 6.42-1.87 0-3.39-2.88-3.39-6.42s1.52-6.42 3.39-6.42 3.38 2.88 3.38 6.42M24 12c0 3.17-.53 5.75-1.19 5.75-.66 0-1.19-2.58-1.19-5.75s.53-5.75 1.19-5.75C23.47 6.25 24 8.83 24 12z"/>
              </svg>
              Medium
            </a>

            <span className="text-dark-200/50 select-none" aria-hidden="true">|</span>

            {/* DexScreener */}
            <a
              href="https://pump.fun/coin/7Epmyp9dMD5SzUtxczbuWwsVARyWdzLFAkzxnvZWpump"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-neon-cyan transition-colors"
              title="DexScreener"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
              DexScreener
            </a>
          </div>
        </div>
      </div>
      </div>
    </main>
  );
}

