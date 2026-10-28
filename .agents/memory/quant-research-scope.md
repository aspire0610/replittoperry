---
name: Quant research scope
description: User-selected default universe and constraints for Taiwan quant research.
---

New quant-research runs should default to 2330.TW. The user can clear the explicit ticker field to select the full market; free-text hypotheses do not implicitly restrict the universe, except that an explicit ticker in a recurring-cash instruction identifies its single-stock target. Existing saved runs keep their recorded scope. Keep signal-based timing separate from recurring-cash investing: a recurring plan buys whole shares on its stated weekday, rolls a market holiday to the next session that week, carries leftover cash, and holds through the end without AI signals. Base its total return on cumulative contributions and compare against a TAIEX plan with the same contribution dates; do not label it signal timing. For signal strategies, preserve explicit buy/sell rules and configurable holdings. Parse explicit share-count and frequency instructions separately from signals; fixed-share entries accumulate shares and an exit signal liquidates the accumulated position. For single-stock timing comparisons, keep the final 40% of historical dates out of candidate selection and report its results only as holdout validation; calculate win rate from completed, net-of-cost round trips and flag small samples. New runs apply 0.1% estimated slippage per side and show a stress case with all trading costs doubled; report average win, average loss, and payoff ratio alongside win rate.

Before any new backtest, use AI to convert the hypothesis into explicit assumptions and show them for user confirmation. Do not load market data or start the backtest until confirmation. For a recurring cash plan, keep per-contribution amount separate from any cumulative contribution cap; the final deposit must be limited to the remaining cap.

The confirmed plan must include the actual entry/exit rules, factor weights, and position sizing shown to the user. Execute that same strategy object after confirmation; do not generate replacement rules in a later AI call.

**Why:** the user clarified that the analysis must judge buy/sell timing and let them set the number of holdings, while separately choosing a recurring-investment simulation that ignores AI signals and holds to the end. They selected held-out validation and 0.1% per-side slippage, and expects explicit share-size instructions to control simulated orders.

**Why:** the user chose an AI interpretation review before backtesting to prevent condition-reading errors and clarified that the weekly amount is a contribution, stopping at the cumulative NT$100,000 cap.

For the daily AI pending list, use the user's adaptive SMC selection rules. Stage 1: ordinary shares and stock ETFs only; exclude warrants, ETNs, bonds, leveraged and inverse products; require volume >=1,000 lots, traded value >=NT$30m, price >=NT$15, daily gain 1.5–9%, volume above prior day, and 5-day gain <15%. Before stock selection, trigger a systemic defense day at declines >=1,500 or declines/advances >=3.0; output zero picks, advise cash/defense, and skip fallback. Tier-1 requires recent bullish BOS/CHoCH or a sell-side sweep reclaimed by close, bullish OB or unfilled bullish FVG support, volume ratio 1.2–3.0, R/R >=2.0, and a 24-month backtest with >=10 settled trades and >=50% wins; tag Tier-1 picks as complete matches. Backtest from next-session open for 10 trading days using fixed SMC stop/target; same-day target/stop ties are losses and no-touch trades are excluded from the win-rate denominator. If fewer than five Tier-1 picks and systemic risk is not triggered, rank secondary candidates by the existing multidimensional quant score and fill up to five, aiming for 3–5 where safe candidates exist; visibly tag them as high-score fallbacks and never claim they passed Tier-1. AI reviews sourced news and earnings-call context, excluding material operating downside, earnings deterioration, or litigation risk.

**Why:** on 2026-10-19 the user first selected explicit SMC gates, then replaced the no-fill/20-trade/55% policy with the attached systemic-risk, 10-trade/50%, and labeled fallback rules.

**Why:** a summary-only confirmation followed by separate strategy generation did not show users the rules that would actually drive the backtest.

**How to apply:** retain 2330.TW as the default candidate scope, label scope in results, define explicit entry/exit and sizing rules, preserve the calibration/validation boundary, expose the chosen cost assumptions, and make any holding-count limit consistent with the selected universe. For new runs, require an explicit user confirmation between AI interpretation and market-data/backtest execution.

Current daily AI pending-scan gates supersede the older Tier-1 thresholds above: accept bullish BOS/CHoCH or reclaimed sell-side sweep within 5 sessions OR a current bullish OB/unfilled FVG support-zone touch; volume ratio >1.2 without an upper cap; R/R >=1.5; at least 5 settled 24-month samples and >=50% wins. When structure qualifies without a support zone, use a recent confirmed swing low for the stop.

**Why:** the user explicitly requested wider SMC eligibility and a lower sample floor on 2026-10-21 to address scans returning zero stocks.

**How to apply:** preserve full-history alignment, liquidity filters, systemic-defense behavior, and clearly label the reduced sample's uncertainty.
