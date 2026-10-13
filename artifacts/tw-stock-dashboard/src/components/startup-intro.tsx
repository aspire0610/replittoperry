import { useEffect, useState, type ReactNode } from "react";
import { Activity } from "lucide-react";

const INTRO_SEEN_KEY = "tw-stock-dashboard-intro-seen-v1";
const INTRO_DURATION_MS = 1_100;

function shouldShowIntro(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
  try {
    return window.sessionStorage.getItem(INTRO_SEEN_KEY) !== "1";
  } catch {
    return true;
  }
}

export function StartupIntroGate({ children }: { children: ReactNode }) {
  const [showIntro, setShowIntro] = useState(shouldShowIntro);

  useEffect(() => {
    if (!showIntro) return undefined;
    try {
      window.sessionStorage.setItem(INTRO_SEEN_KEY, "1");
    } catch {
      // The intro still works if session storage is unavailable.
    }
    const timer = window.setTimeout(() => setShowIntro(false), INTRO_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [showIntro]);

  if (!showIntro) return children;

  return (
    <div
      className="startup-intro"
      role="status"
      aria-live="polite"
      aria-label="台股市場觀測"
      data-testid="status-startup-intro"
    >
      <div className="startup-intro-content">
        <span className="startup-intro-eyebrow">TAIWAN MARKET MONITOR</span>
        <span className="startup-intro-mark" aria-hidden="true">
          <Activity size={25} strokeWidth={1.7} />
        </span>
        <h1>台股市場觀測</h1>
        <p>市場脈動，即刻掌握</p>
        <svg
          className="startup-intro-signal"
          viewBox="0 0 184 34"
          aria-hidden="true"
        >
          <path d="M2 20h43l12-1 11-12 11 20 13-15 11 8h69" />
        </svg>
        <span className="startup-intro-progress" aria-hidden="true">
          <span />
        </span>
      </div>
    </div>
  );
}