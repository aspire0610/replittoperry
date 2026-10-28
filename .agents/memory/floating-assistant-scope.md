---
name: Floating assistant scope
description: User-selected behavior and data boundaries for the cross-page AI chat.
---

The user wants the existing assistant replaced by an AI CEO: they can describe a problem in the dashboard or LINE, and the CEO should create specialist agent employees to analyze it, execute the work, and consolidate the answer. The website and LINE should use the same CEO workflow.

**Why:** On 2026-10-18, the user clarified that the separate research-office page was not the intended product; the CEO should replace the current AI assistant and also work through LINE.

**How to apply:** Keep the existing assistant entry point and conversation flow, remove plan-only JSON parsing from the client, and share CEO planning, execution, and results across web and LINE. Do not claim independent employee execution unless real agent jobs are run.

Only dispatch research employees for research-heavy questions; simple greetings, conversions, creative requests, and direct quote lookups stay on the CEO fast path.

**Why:** The user chose research-only dispatch for the automated workflow.

**How to apply:** Treat detailed analysis, comparisons, investment risk, and trend research as dispatch candidates; avoid extra model calls for simple requests.

The CEO chat is a market-wide natural-language conversation, not a single-stock-only assistant. Users can ask about the Taiwan market, industries, ETFs, individual stocks, and general investment research. Do not automatically make the currently selected stock the topic of every message. Do not add the complete watchlist or portfolio holdings by default.

**Why:** The user asked to remove the individual-stock restriction and make CEO chat handle natural questions across the market.

**How to apply:** Use a market-wide conversation history; infer stock scope from the user's explicit question rather than the page selection. Use verified financial data and surface sources; prefer official exchange records for ETF distributions. Keep the full watchlist and portfolio out of context unless the user expands that scope.

The user intends this stock-decision system for personal experimental use, with direct, concise short-horizon buy / wait / sell guidance and validated price levels.

**Why:** The user explicitly said they personally will use the system and wants natural-conversation answers that state the decision and levels directly.

**How to apply:** Keep outputs focused and actionable for a single user, but preserve source timestamps, uncertainty, and the distinction between direction estimates and profit guarantees.

For research-heavy CEO chat, return the verified initial answer without waiting for specialist agents; queue cross-checks in the background, push the completed result as a second LINE message, and show web results in CEO Research Office. An agent failure must not mark a usable initial answer as a failed job.

**Why:** The user chose a fast first response followed by the deeper result to reduce conversational stalls and compounded provider timeouts.

**How to apply:** Keep simple questions on the direct path, queue only detailed research, prioritize queued CEO jobs in the existing worker, and preserve source/evidence validation in the follow-up answer.