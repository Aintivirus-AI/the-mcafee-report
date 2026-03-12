import { MainHeadline } from "@/components/MainHeadline";
import { MobileHeadlineList } from "@/components/MobileHeadlineList";
import { DesktopHeadlineLayout } from "@/components/DesktopHeadlineLayout";
import { TokenTicker } from "@/components/TokenTicker";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BreakingSiren } from "@/components/BreakingSiren";
import { getSidebarHeadlines, getMainHeadline, getBreakingHeadline } from "@/lib/db";
import { MayhemBanner } from "@/components/MayhemBanner";
import { SimpleFooter } from "@/components/SimpleFooter";

// Revalidate every 10 seconds
export const revalidate = 10;

export default function Home() {
  const allSidebarHeadlines = getSidebarHeadlines(72);
  const mainHeadline = getMainHeadline();
  const breakingHeadline = getBreakingHeadline(2, 80);
  

  return (
    <main className="main-content">
      <div className="grid-bg min-h-screen">
        {/* Mayhem Mode indicator */}
        <MayhemBanner />

        {/* Breaking News Siren */}
        <BreakingSiren headline={breakingHeadline || null} />

        {/* Page Title */}
        <div className="border-b border-dark-200/30 py-4">
          <div className="container mx-auto px-4">
            <div className="flex items-start justify-between">
              <div className="w-10 flex-shrink-0" /> {/* Spacer for centering */}
              <div className="text-center min-w-0 flex-1">
                <h1 className="text-2xl md:text-3xl font-bold tracking-wider">
                  <span className="text-neon-cyan">THE MCAFEE REPORT</span>
                </h1>
                <p className="text-gray-500 text-xs mt-1 tracking-widest">
                  Powered by{" "}
                  <a 
                    href="https://aintivirus.ai/" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-neon-cyan hover:underline"
                  >
                    AintiVirus
                  </a>
                </p>
                <TokenTicker />
              </div>
              <div className="flex-shrink-0 mt-1">
                <ThemeToggle />
              </div>
            </div>
          </div>
        </div>

        {/* Neon divider */}
        <div className="neon-divider" />

        {/* Main content */}
        <div className="container mx-auto px-4 py-8">
          {/* Mobile: Main headline first */}
          <div className="lg:hidden mb-8">
            <MainHeadline headline={mainHeadline} />
          </div>

          {/* Mobile: Unified headline list with sort filters */}
          <div className="lg:hidden">
            <MobileHeadlineList headlines={allSidebarHeadlines} />
          </div>

          {/* Desktop: Three column layout with filter */}
          <div className="hidden lg:block">
            <DesktopHeadlineLayout
              headlines={allSidebarHeadlines}
              mainHeadline={mainHeadline}
            />
          </div>
        </div>

        {/* Live Activity Feed moved to /analytics */}
      </div>

      <SimpleFooter />
    </main>
  );
}
