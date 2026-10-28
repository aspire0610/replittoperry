---
name: Market-wide scan integrity
description: Daily scan uniqueness, interrupted-job handling, and source-completeness policy for Taiwan equities.
---

Automatic market-wide scan entry points reuse one persistent job per Taiwan calendar day. Do not automatically rerun a stale or interrupted scan; surface it as failed/incomplete instead. An explicit user-triggered manual rerun may create a fresh same-day job after the prior job completes, but must reuse any active job and remain rate-limited. When data is missing or stale, query alternate official or verified historical sources before marking it unavailable; never relax per-stock source, date-alignment, history, or backtest thresholds. If either exchange or some stock histories remain unavailable, AI may select from individually qualified candidates in the verified subset, but the result must be labeled partial and never described as a complete-market ranking. Preserve forward-validation, news, and risk/reward thresholds.

**Why:** automatic requests should not create repeat scans, while missing inputs should be looked up from other sources. Requiring perfect universe coverage can suppress otherwise valid individual candidates; selecting verified candidates is useful only when partial coverage remains explicit and individual evidence gates stay intact.

**How to apply:** route automatic dashboard/API/assistant/worker requests through Taiwan-date idempotency. Prefer an active job over a completed same-day result so a deliberate manual rerun stays visible. Reserve the force path for a deliberate user action; try supplemental providers for missing reports/history, never allow two active jobs, exclude stocks with incomplete evidence, and retain partial status if backups fail.

For the market-wide AI scan, request the 24-month backtest window plus a 60-calendar-day warmup cushion instead of a generic three-year range. Keep the exact 486-bar and date-alignment checks unchanged.

**Why:** the strategy needs 20 earlier sessions to compute its volume and price plan at the start of the 24-month backtest. A 60-day cushion provides that warmup while avoiding unnecessary monthly requests.

**How to apply:** limit the shorter window to this scan, not user-facing history views. Preserve the exact 486 official aligned bars, source checks, and expected as-of date; the warmup only supports earlier indicator calculations and is not an eligibility substitute.

For the user's daily AI pending scan, follow the three-stage funnel recorded in quant-research-scope.md. Use official daily data, validate as-of alignment, retain the 24-month history requirement plus warmup, and never relax a stage gate when history or an exchange report is missing. Label partial coverage and distinguish strategy exclusions from missing-data exclusions; do not fill the five slots with unqualified stocks.

**Why:** the user replaced the earlier no-win-rate-floor strategy with a three-stage funnel; the completeness policy still prevents missing data from being misreported as a strategy result.

**How to apply:** run cheap official close filters before requesting recent history; use validated per-stock fallback when bulk access is denied; cache longer history by ticker in the running worker. Use completed closes only; reject stale, missing, or misaligned data. Show exact stage counts and label incomplete coverage without hiding verified qualified picks.

When a short-range per-stock request has an official as-of date, anchor its start and end to that date rather than wall-clock today. Otherwise a weekend or market holiday can leave fewer than 21 bars and trigger a needless wider-range retry across much of the universe.

**Why:** on 2026-10-19 the forced fallback scan used a Friday close while wall-clock time was Monday; the short-range request could span the wrong 31-day window and its retry did not improve the cold-scan duration.

**How to apply:** pass the expected official as-of date through range selection, validate the 21 ordered bars, and widen only when that anchored window truly fails.

For timed market-wide history calls, propagate one AbortSignal through provider fetches, retry delays, and concurrency queues. Abortable calls must bypass shared in-flight response caches so one scan cannot cancel another caller's shared request.

**Why:** a scan timeout that only rejects the caller leaves provider requests and queued retries running; sharing those requests would also make cancellation unsafe for unrelated callers.

**How to apply:** abort the per-candidate controller at the deadline, remove aborted waiters from provider queues, and rethrow cancellation through fallback handlers instead of starting another source.

When qualified picks are empty, an optional unqualified watchlist must remain separate from picks, show only candidates with locally verified data that failed an identified gate before final AI selection, and be labeled observation-only. State the actual failed condition and what evidence to watch next. Never include candidates rejected by final AI review or change any qualification thresholds to fill the list.

**Why:** the user chose to see non-qualified names separately when strict criteria produce no picks; mixing near-misses into the qualified list would misstate their status.

**How to apply:** compute the earliest failed stage from local scan evidence, include the candidate's measured values and a specific next observation, limit the list, and keep it out of candidate counts, AI batches, and recommendation language.
