import { useEffect, useState } from "react";

const HEADING = "先看市場，再看個股。";
const DESCRIPTION = "先看大盤與個股近期走勢，再試算可能投入金額和風險。分析僅供參考，不保證未來價格。";
const TYPE_DURATION_MS = 5_000;
const HOLD_DURATION_MS = 2_000;
const TV_OFF_DURATION_MS = 520;
const SEEN_KEY = "tw-stock-dashboard-login-intro-seen-v1";
const STARTUP_INTRO_SEEN_KEY = "tw-stock-dashboard-intro-seen-v1";
const STARTUP_INTRO_DURATION_MS = 1_100;
const TOTAL_CHARACTERS = Array.from(HEADING).length + Array.from(DESCRIPTION).length;

type IntroPhase = "typing" | "holding" | "powering-off" | "collapsed" | "static";

function getInitialPhase(): IntroPhase {
  if (typeof window === "undefined") return "static";
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return "static";
  try {
    return window.sessionStorage.getItem(SEEN_KEY) === "1" ? "static" : "typing";
  } catch {
    return "typing";
  }
}

function getStartupDelay(): number {
  try {
    return window.sessionStorage.getItem(STARTUP_INTRO_SEEN_KEY) === "1"
      ? 0
      : STARTUP_INTRO_DURATION_MS;
  } catch {
    return STARTUP_INTRO_DURATION_MS;
  }
}

export function DashboardLoginIntro({ onDismiss }: { onDismiss?: () => void }) {
  const [phase, setPhase] = useState<IntroPhase>(getInitialPhase);
  const [visibleCharacters, setVisibleCharacters] = useState(0);

  useEffect(() => {
    if (phase === "collapsed" || phase === "static") onDismiss?.();
  }, [onDismiss, phase]);

  useEffect(() => {
    if (phase !== "typing") return undefined;

    let typeInterval: number | undefined;
    let finishTyping: number | undefined;
    let powerOff: number | undefined;
    let collapse: number | undefined;
    const startupDelay = window.setTimeout(() => {
      typeInterval = window.setInterval(() => {
        setVisibleCharacters((current) => Math.min(TOTAL_CHARACTERS, current + 1));
      }, TYPE_DURATION_MS / TOTAL_CHARACTERS);
      finishTyping = window.setTimeout(() => {
        if (typeInterval !== undefined) window.clearInterval(typeInterval);
        setVisibleCharacters(TOTAL_CHARACTERS);
        setPhase("holding");
      }, TYPE_DURATION_MS);
      powerOff = window.setTimeout(
        () => setPhase("powering-off"),
        TYPE_DURATION_MS + HOLD_DURATION_MS,
      );
      collapse = window.setTimeout(() => {
        setPhase("collapsed");
        try {
          window.sessionStorage.setItem(SEEN_KEY, "1");
        } catch {
          // The intro still works when session storage is unavailable.
        }
      }, TYPE_DURATION_MS + HOLD_DURATION_MS + TV_OFF_DURATION_MS);
    }, getStartupDelay());

    return () => {
      window.clearTimeout(startupDelay);
      if (typeInterval !== undefined) window.clearInterval(typeInterval);
      if (finishTyping !== undefined) window.clearTimeout(finishTyping);
      if (powerOff !== undefined) window.clearTimeout(powerOff);
      if (collapse !== undefined) window.clearTimeout(collapse);
    };
  }, []);

  const headingCharacters = Array.from(HEADING);
  const descriptionCharacters = Array.from(DESCRIPTION);
  const shownHeading = phase === "static" || phase === "holding" || phase === "powering-off" || phase === "collapsed"
    ? HEADING
    : headingCharacters.slice(0, visibleCharacters).join("");
  const shownDescription = phase === "static" || phase === "holding" || phase === "powering-off" || phase === "collapsed"
    ? DESCRIPTION
    : descriptionCharacters.slice(0, Math.max(0, visibleCharacters - headingCharacters.length)).join("");
  const typing = phase === "typing";
  const isCollapsed = phase === "collapsed";

  return (
    <div
      className={`dashboard-intro-collapse${phase === "powering-off" ? " is-powering-off" : ""}${isCollapsed ? " is-collapsed" : ""}`}
      aria-hidden={isCollapsed}
      data-testid="dashboard-login-intro"
    >
      <div className="dashboard-intro-tv-screen">
        <div className="dashboard-intro-copy">
          <h1 aria-label={HEADING} data-testid="text-dashboard-intro-title">
            <span aria-hidden="true">{shownHeading}</span>
            {typing && visibleCharacters <= headingCharacters.length && (
              <span className="dashboard-intro-caret" aria-hidden="true" />
            )}
          </h1>
          <p className="lede" aria-label={DESCRIPTION} data-testid="text-dashboard-intro-description">
            <span aria-hidden="true">{shownDescription}</span>
            {typing && visibleCharacters > headingCharacters.length && (
              <span className="dashboard-intro-caret" aria-hidden="true" />
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
