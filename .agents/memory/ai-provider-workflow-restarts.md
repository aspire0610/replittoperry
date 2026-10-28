---
name: AI provider workflow restarts
description: Local API workflow restarts can coincide with live AI requests from active preview clients.
---

**Rule:** Treat restarting the API workflow as potentially triggering a real provider request when a signed-in dashboard preview is active; do not use a restart as an AI provider health check.

**Why:** After an API workflow restart, the local service log showed a stock-assessment request reaching 1min.ai and timing out before the fallback completed.

**How to apply:** Prefer mocked provider tests for validation. Before restarting the API workflow after AI changes, account for active preview clients and possible provider credits; verify the production build separately.

For interactive stock analysis, cap the primary provider timeout and total fallback window instead of waiting through every configured provider's full timeout. Time-box optional news, fundamentals, and index-history lookups; keep verified in-session stock quotes and official daily history as hard requirements where the analysis depends on them.

**Why:** Sequential provider failures made both the market-wide scan and single-stock analysis feel stuck, while optional research and index context should not delay a trustworthy core answer indefinitely.

**How to apply:** Keep interactive time budgets explicit per operation, prefer a small bounded set of fast fallbacks, and return a clear unavailable state when the required AI or fresh quote cannot be obtained.

Do not auto-start the multi-period AI historical backtest when a stock dashboard mounts. Require an explicit user action so the backtest cannot consume the shared provider pool or place interactive CEO questions into cooldown.

**Why:** On 2026-10-18, opening the stock view automatically started a 20-period AI validation; provider failures and cooldowns then caused the user's immediate stock-analysis question to fail.

**How to apply:** Keep costly historical/model evaluation opt-in or run it on a separate bounded queue; interactive questions should not trigger it implicitly.

Market-wide final selection also needs a compact candidate payload. Sending dozens of full indicator, scoring, history, scenario, and news records can make providers reject the request with 413, enter cooldown after 429, or time out; client retries can amplify the outage and leave progress displaying the last selection percentage.

**Why:** The live scan exhausted Groq, Gemini, and OpenRouter in sequence on a large final-selection request.

**How to apply:** Bound and compact the final AI shortlist, limit optional news evidence, disable automatic query retries for this scan, and reset progress when the server reports failure. Verify with mocked provider tests rather than repeatedly calling live providers.

Single-stock AI assessment uses six months of official daily history, which retains enough sessions for its 120-day context while avoiding an unnecessary full-year fetch. Preserve the minimum history required by the indicators and backtest before expanding the range.

**Why:** Loading a full year meant more monthly exchange requests on the interactive path and increased the time before any assessment could appear.

**How to apply:** Keep optional market context time-boxed and retain the six-month history unless a measured product need requires longer coverage; show insufficient-data status if required indicators cannot be computed.

For multi-stage CEO research, use production-realistic per-provider deadlines for the initial answer and each researcher; keep the total path under the browser request deadline. Preview success alone does not establish that short production timeouts are sufficient.

**Why:** A production stock-cause question first saved a failed CEO job with both researchers failed, while a simple production chat succeeded. After increasing the budgets, a real retry completed with one researcher failed, but the answer still lacked verified causal evidence. Provider-stage logs did not expose the failure status.

**How to apply:** Keep these stages independently bounded, but avoid sub-three-second research ceilings. A successful job status or health check does not prove a useful answer; verify stage outcomes and evidence quality. Use mocked tests and sanitized runtime logs rather than repeatedly probing live AI.

For stock-assistant responses, malformed optional direction-probability estimates should become unavailable (`null`) rather than invalidate an otherwise safe, verified answer. Keep answer, action, and cited-fact validation strict.

**Why:** A scheduled report failed because Gemini's extra probability field violated its format even though the core response could otherwise be validated.

**How to apply:** Fail closed on the optional estimate, not on the whole answer; give scheduled jobs bounded but realistic fallback time, and validate with mocks before any live retry.

If an AI assistant stage fails after a verified stock assessment is already cached, preserve that assessment as a clearly labeled partial report instead of discarding it or presenting it as a completed AI answer.

**Why:** A scheduled research run can successfully create a conservative rule-based assessment, then fail its separate explanatory AI call because providers are rate-limited or cooling down.

**How to apply:** Read only the still-valid in-process assessment cache; never refetch or trigger another model call to construct the fallback, and keep the UI visibly marked as failed/partial.

For scheduled stock research, a successful AI explanation does not make the report complete if the underlying stock assessment fell back to rules. Mark the report failed/partial, identify the rule-based assessment, and label any model explanation as supplementary.

**Why:** A live run exhausted the stock-assessment providers, then Gemini generated an explanation from the conservative rule-based assessment; recording that as completed concealed the failed assessment stage.

**How to apply:** Preserve the assessment provider separately from the explanation provider and base the scheduled report status on both stages; never make a second provider call solely to replace the fallback.

Market-wide scan logic runs in a separately managed worker; restarting only the API can leave scans on old code. Avoid using `GET /stocks/ai-picks` for verification because it can start a fresh scan when no current result is available; inspect a known scan-job record instead.

**Why:** The development API was restarted without its scan worker, so a later scan still used the old result-formatting logic. A verification GET then started another full scan.

**How to apply:** After changing market-wide scan code, restart the development scan worker as well as any affected API service. Verify completed results through the job record or its read-only job endpoint.
