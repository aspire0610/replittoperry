import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { StockAiMonitor } from "../components/stock-ai-monitor";
import { FuturesDayMonitor } from "../components/futures-day-monitor";
import "./ai-picks.css";

export default function AiPicksPage() {
  const [isCompactHeader, setIsCompactHeader] = useState(false);

  useEffect(() => {
    const updateHeaderSize = () => {
      const scrollY = window.scrollY;
      setIsCompactHeader((wasCompact) => wasCompact ? scrollY > 24 : scrollY > 92);
    };
    updateHeaderSize();
    window.addEventListener("scroll", updateHeaderSize, { passive: true });
    return () => window.removeEventListener("scroll", updateHeaderSize);
  }, []);

  return (
    <main className={`ai-picks-page${isCompactHeader ? " is-title-compact" : ""}`} data-testid="page-ai-picks">
      <div className="ai-picks-inner">
        <div className="aipick-sticky-stack">
          <div className="aipick-topline">
            <div className="aipick-breadcrumb"><span>市場研究</span><span>/</span><strong>AI 盯盤</strong></div>
          </div>

          <header className="aipick-hero">
            <div className="hero-copy">
              <p className="aipick-eyebrow"><Activity size={13} /> TAIWAN EQUITY RESEARCH / CATEGORY MONITOR</p>
              <h1>AI <em>盯盤</em></h1>
              <p className="hero-lede">依可驗證行情瀏覽台股分類；選擇個股查看分時走勢、資料時間與多空力道。</p>
            </div>
            <div className="hero-note">
              <span className="hero-note-mark">TW</span>
              <div><small>規則透明 · 可追溯行情</small><strong>分類條件 × 分時走勢</strong><span>多空力道是價格／成交量代理值</span></div>
              <span className="hero-note-number mono">TW</span>
            </div>
          </header>
        </div>

        <FuturesDayMonitor />
        <StockAiMonitor />
      </div>
    </main>
  );
}
