---
name: AI-driven financial action guidance
description: Safety rules for AI-composed stock direction and price plans without formula overrides.
---

For stock analysis, let the model weigh current market and stock evidence and propose the directional level, action, and context-specific price plan. Treat its output as untrusted: require complete positive prices and reasons, consistent action and bias, and stop < entry < target for a buy plan. Do not override its direction or price choices with fixed indicator votes, ATR-distance rules, or reward-to-risk thresholds. If a buy plan fails structural validation, withhold its prices and change the action to wait while preserving the AI bias. Compose displayed instructions on the server from the final action and validated references; never display model free-text commands directly.

**Why:** Fixed formula gates can discard context-specific AI estimates and force an unnecessary wait; model free text can still contradict the final action or validated prices.

**How to apply:** When extending stock assessment, retain structural validation and server-composed guidance. Label non-buy reference prices as observation or reassessment levels, never as entry signals.

For buy-price checks, distinguish a successfully checked quote from an unavailable buy plan. If no validated plan exists, explain whether the direction is not buy or which plan fields failed validation, and compare the user's entered price with the quote; do not tell them to fetch a quote the check already used.

**Why:** A generic do-not-buy message that blames missing market data even when the quote is present hides the actual gate and makes every entered price appear to receive the same unexplained verdict.

**How to apply:** Build the explanation from the validated quote, assessment action/summary, plan status/message, and validated plan levels; keep the verdict conservative when required plan data is missing.

For AI forecast ranges, treat low / central / high as one all-or-none set; show them only when all three are positive and ordered. A central forecast may extend the historical chart as a visibly distinct dashed series on future-date points; never merge projected values into observed OHLC or imply they are probabilities.

**Why:** A structurally valid model response can still contain an incomplete or contradictory range, and charting estimates as if they were observed prices misleads readers.

**How to apply:** Validate the range at the API boundary, suppress it if validation fails, and label every projected point and forecast horizon. Keep actual daily bars and projected values as separate chart series.

During Taiwan's regular stock session, AI assessment and buy-price checks may use a verified trade timestamped within the current session and no more than three minutes old. If no such quote is available, return an explicit unavailable/data-insufficient result instead of substituting the official close. Outside the session, use the latest official daily close even when a provider reports a later-timestamped after-hours trade. A complete, validated plan may be shown from that close as a conditional reference for the next trading day; clearly label its close date and require a fresh live-price check before acting.

**Why:** Provider timestamps can advance after the close without representing a new regular-session price, and a cached intraday analysis can otherwise survive into after-hours. The user wants post-close price checks to remain usable while clearly distinguishing a next-session estimate from a live or executable price.

**How to apply:** Preserve the source and trading date anywhere the assessment is shown. Use fresh in-session trades during the session; if they cannot be verified, withhold the AI assessment and explain the data gap. Only use official-close comparisons outside the session, labeled as conditional next-session references, never as live quotes or immediate orders.

Keep all user-facing dashboard copy and AI responses concise and in plain Traditional Chinese for Taiwan readers. Across all AI surfaces, lead with the answer; remove filler, repeated explanations, and vague hedging. For individual-stock analysis, lead with a direct action and short reason. Be decisive when evidence agrees, but say the direction is unclear when evidence conflicts. Explain necessary financial terms briefly, avoid unexplained jargon and overconfident claims, and retain data sources, update times, dates, and risk notices.

**Why:** The user wants answers across the entire system to be direct and not padded with vague language, while retaining accuracy and avoiding overstated financial certainty. Real provider replies can still contain jargon after prompt changes alone.

**How to apply:** Review visible UI, loading and error states, AI prompts, and generated responses together. Put the action first, give only the strongest verifiable evidence and material counter-signal, and do not force certainty when evidence conflicts. Apply deterministic plain-language cleanup to every user-facing response after validation, test it against real output examples, and keep source/date fields and necessary risk disclosures intact.

For structured AI operations, parse and validate the primary provider's response inside the fallback boundary; otherwise malformed JSON cannot trigger the backup provider. Safely normalize wrappers and unescaped control whitespace, but still validate every field used. Return HTTP 429 only when all configured providers are rate-limited; classify mixed provider failures by their gateway errors or timeouts. Never log raw model output for diagnostics.

**Why:** A post-fallback parse failure surfaced as a 502 even when the primary response could have been repaired or routed to the backup; reporting one upstream 429 as the final result hid subsequent 502 and timeout failures.

**How to apply:** Use the same bounded parser for fallback validation and final response handling. Test all-429, mixed 429/5xx, and timeout cases separately.

Disclaimers about missing financial statements or institutional trading data must reflect the same coverage values used to build the answer. Never claim a data category is unavailable when it was included.

**Why:** A static disclaimer contradicted an answer that had successfully used both categories, making the response less trustworthy.

**How to apply:** Compose data-coverage disclaimers from the response's coverage object and verify both complete-coverage and partial-coverage cases.

For stock-assistant action questions, directly show the personal position action, validated buy / target-sell / stop prices when available, the 1–5 trading-day reassessment horizon, and the current qualitative confidence. If a plan is based on the official close, label it as a conditional next-session reference and require a new quote check; do not present it as executable. Do not inflate confidence or present it as a win probability.

**Why:** The user wants action answers to state these decision fields clearly; fabricated prices or an overstated confidence label would undermine safe, trustworthy guidance.

**How to apply:** Compose a concise, conversational summary from the validated assessment, separate the user's position action from the stock's general direction, label the horizon as a review period, and describe stop distance only as a per-share estimate.

For a buy/sell-exhaustion traffic light, combine only same-date official institutional net trading with recent official daily OHLCV. Missing data or date mismatch must show unavailable; mixed evidence must stay neutral. Any green or red status is a heuristic illustration, not a verified trading edge, actual holdings, or real-time order flow.

**Why:** The user selected this exact evidence combination and asked for an illustrative traffic light without implying that exchange net-flow data reveals actual positions.

**How to apply:** Require matching dates and enough volume history, show the inputs and date, and keep the explanation and limitations visible beside the light.

When the user asks whether the Taiwan market will rise or fall at the next session open, use recent official index performance, dated current-news results, and a fixed, reproducible technical rule with a walk-forward historical hit rate. Keep the rule's observed rate separate from the AI's current outlook.

**Why:** The CEO answered “明天開盤會漲嗎” with a generic hedge and no market evidence; the user wants recent market/news evidence and a rule-based historical rate similar to stock-pick cards.

**How to apply:** Trigger broad-market history and news search for next-session forecasts. Show the rule, target horizon, wins/sample count, observed hit rate, and uncertainty only when the sample threshold is met. Cite dated market/news sources; never mix news-informed AI judgment with the price-only backtest or call historical hit rate a guaranteed forecast.

For live-stock scorecards, show earned points and the points actually available out of 100; never rescale a partial score or fill unavailable chip data with estimates. Keep the scorecard and price-only reward/risk scenarios diagnostic and separate from the AI action, which remains governed by the existing evidence-based validation.

**Why:** The user wants the 40/30/30 scorecard while explicitly skipping the unavailable main-force-concentration data; an apparently complete grade or score-driven action would misstate the evidence.

**How to apply:** Display each component's source status and point cap, explain any missing items, and label calculated support/resistance scenarios as what-if references rather than buy/sell instructions. Individual-stock reports follow the supplied four-section Markdown template: summary/signal, 40/30/30 diagnostics, two price scenarios, and actionable insight.

For share sizing, use only the user's explicitly entered single-trade budget and buy price; never assume an amount or present the result as an AI-selected investment. Estimate the standard Taiwan buy commission at 0.1425% and disclose that broker minimum fees and discounts are excluded.

**Why:** The user chose budget-based share sizing, and the calculation must remain transparent about both its source and fee limits.

**How to apply:** Calculate the maximum whole shares within the entered budget including the estimated buy fee, while keeping the calculator separate from the AI's buy/no-buy conclusion.

For LINE stock-action replies, show the latest available quote with its Taiwan-local source time and include an AI-subjective direction probability only when evidence supports it. Define the event and horizon, label the estimate as unbacktested and uncalibrated, and say when it cannot be estimated; never imply it is measured historical win rate or profit probability.

**Why:** The user wants every LINE user to receive stock quote functionality and an explicit probability rather than vague language, and selected subjective AI estimates over historical backtest rates.

**How to apply:** Keep account binding optional for general LINE stock questions, use verified stock market data rather than model memory, and withhold percentages for neutral or insufficient evidence.

For LINE market-wide follow-ups, carry recent Taiwan-market context forward, cite available index/breadth figures with their distinct source times or dates, and make every operation step conditional on an observable signal. A subjective 1–5 day index-direction probability may be shown when evidence supports it, but never label it a strategy entry win rate or profit probability.

**Why:** The user found generic statements such as “observe global conditions” untrustworthy and asked for precise evidence plus an explanation of what to do.

**How to apply:** Do not answer follow-up market-action questions from model memory alone; fetch the official market snapshot, separate live index values from daily breadth, explain a concrete trigger/action/review condition, and state when price levels or strategy win rates cannot be verified.

For the dashboard's AI market-wide pick list, use a verified in-session trade for each stock while Taiwan's market is open; outside the session use the latest official close and label it. Before excluding a candidate for missing evidence, query the relevant official source and an available alternative; distinguish unavailable optional fields from failed mandatory quote or price-plan checks. Search company-specific catalysts instead of using one mixed-market query. Return up to ten candidates, but never fabricate data or force a minimum count. AI handles current news context and judgment; code calculates indicators, scenarios, and historical rule performance from official data. Keep AI's current subjective five-day estimate distinct from program-calculated historical rates.

**Why:** The user clarified on 2026-10-14 that the picks had stale stock data and that the >60% condition must be validated by AI against current evidence, not achieved by changing probability numbers. On 2026-10-17 the user added that missing information should trigger further research rather than immediate omission, and failed preliminary batches should continue checking until the strongest evidence-backed result is available.

**How to apply:** Verify quote source, trade timestamp, and freshness before including in-session candidates; pass verified prices, local indicators, and dated company-specific news to AI for current judgment. Retry missing official coverage through a credible alternative and show provenance/coverage. Retry a failed AI batch with smaller evidence only for payload-too-large or invalid structured output; do not recursively retry rate limits, timeouts, or upstream outages. Rank available AI five-day estimates high to low and return the top candidates without a hard 60% cutoff; keep the estimate labeled uncalibrated. Historical rates must be calculated by code from official OHLCV bars, with longer official history fetched when the shortlist has too few samples; do not make retrospective AI calls to create historical validation rows.

**Why:** The 2026-10-17 full-market scan recursively split batches after 429/502 provider failures, multiplying calls while providers were in cooldown. Its validator also rejected otherwise valid probability estimates that were not multiples of five.

For the dashboard's full-market shortlist, additionally require same-date institutional data showing both foreign investors and investment trusts as net buyers, plus at least one valid direct-entry or pullback scenario with R/R >= 2. Attempt retrieval from official sources and a credible alternative before failing these gates. Rank candidates first by the AI's five-day upward estimate, return up to ten, and allow zero only when there is no usable estimate or entry scenario; historical qualification is shown separately, not used as a blocker while coverage is sparse. Do not promise 100% availability or invent an AI probability in a quant-only fallback.

**Why:** The user supplied a stricter daily AI selection brief with a small, high-conviction shortlist and requested a quant-only fallback; a fallback must not be presented as AI judgement or bypass the evidence gates.

**How to apply:** Treat fresh-quote checks as mandatory, align institutional data to the official market date, retry required missing data through an alternative source, then apply the institutional and R/R gates. Rank the surviving candidates by AI's five-day estimate without a fixed percentage cutoff. If a future quant fallback is added, label it separately and never give it an AI probability.

When adding price-action frameworks such as SMC or Granville's moving-average patterns, derive labels from official daily OHLC and present them as candidate chart conditions, not verified institutional activity, intent, or trading edge. For Granville, keep the 20-day average as the main reference; mark clear crossings or actual touches/reclaims, but show observed distance for vague "near/far" cases instead of inventing a fixed threshold. These labels must not override the AI's direction or action.

**Why:** Price patterns can be labeled reproducibly without revealing who traded or proving that the pattern predicts a profitable outcome; the source article does not define universal near/far distances.

**How to apply:** Include the source date, timeframe, observed price distance, and data limits; keep qualitative cases contextual, and require separate historical validation before presenting any pattern as an actionable strategy rule.

Both scheduled LINE market summaries must include AI analysis of Taiwan-market and TAIEX performance, a conditional outlook, observable items to watch, and general operational guidance; quote-only messages are insufficient.

**Why:** The user said both pre-market and closing summaries should interpret the market rather than only deliver prices.

**How to apply:** Anchor the summary to the official TAIEX close, change, percentage, and source date. Distinguish prior-session performance and today's outlook before the open from today's actual performance and next-session outlook after the close. Keep guidance non-personalized and conditional on observable signals.

Taiwan pre-market summaries should include the previous U.S. session's Nasdaq Composite and Dow Jones percentage moves, dated market-news cues, explicitly sourced upcoming economic events, and a clearly subjective, conditional AI view. Do not invent missing index values or event dates.

**Why:** The user requested these specific cross-market inputs and an AI interpretation in the pre-market summary.

**How to apply:** Use timestamped provider data for both U.S. indices, keep search snippets labeled as unverified cues, mention calendar events only when the supplied source gives a clear date, and state when information is unavailable.

LINE closing summaries should include evidence-qualified possible reasons for the day's TAIEX move, observable items to watch, and a conditional outlook for the next five Taiwan trading days. Keep causes explicitly tentative unless sources establish them, and never present the outlook as certain.

**Why:** The user requested an AI-subjective post-close explanation, future considerations, and a five-trading-day scenario.

**How to apply:** Anchor the explanation to the official close, moving-average context, and dated news leads. Say when the cause cannot be confirmed; state conditions that would change the five-day view and retain the subjective, non-guaranteed framing.

For LINE stock questions phrased as “can I buy?” or “is this suitable to buy?”, route to the stock-specific assessment instead of the generic chatbot. Give a direct buy/wait/insufficient-data conclusion from verified market data; never fabricate a buy plan.

**Why:** A colloquial buy-suitability question was misrouted to general chat, which refused to assess the stock rather than using the available market-analysis flow.

**How to apply:** Keep natural-language buy intent detection aligned between LINE routing and the stock assistant's action-answer detection, and test representative Chinese phrasings such as “今天 2449 可以買嗎”.

The user's “兩點一線” stock-operation framework means showing entry, stop-loss, and target prices together.

**Why:** The user clarified this framework when confirming the interpretation of their request.

**How to apply:** Present the three levels as one coherent plan, validate their ordering and reasons, and label them as conditional estimates rather than guaranteed execution prices.

Qualify an individual-stock AI buy action only when that ticker has at least 100 settled five-trading-day direction outcomes and at least 100 resolved price-plan outcomes, and each metric independently has a 95% Wilson lower bound of at least 80%. If either metric is unavailable or fails, return wait and withhold executable plan prices while retaining the original forecast for forward tracking. Keep quantitative strategy backtests independent; do not combine them into this per-stock gate.

**Why:** The user requested an evidence-based hard gate while keeping direction accuracy, price-plan outcomes, and quantitative backtests as separate measures.

**How to apply:** Fail closed when either tracking dataset is unavailable; only compute each lower bound from its own settled sample, and never present raw historical percentage alone as meeting the 80% qualification.

For the stock dashboard's market-wide shortlist, show a final five-trading-day directional win-rate estimate that combines the current AI probability with a deterministic same-direction momentum backtest. Keep AI news/context separate; cap the rule's influence at 30%, scale it linearly to full weight at 20 same-direction samples, and use the AI probability alone when no rule sample is usable. This is an estimate of directional accuracy, not profit probability.

**Why:** The user explicitly asked for AI and computation to produce one final win-rate number instead of repeatedly labeling the displayed probability as “not a win rate.”

**How to apply:** Keep the prediction horizon exactly five trading days, show the AI estimate and rule's sample count/rate beside the final number, and retain later out-of-sample evaluation before changing the blend weights.

For the market-wide shortlist, calculate indicators and conditional trade scenarios locally for the top 300 by turnover. Historical qualification is risk context, not a hard blocker while coverage is sparse; keep AI probability >60%, at least one institutional net buyer, and local R/R >=1.5. Reuse the same local plan in detail.

**Why:** The user explicitly asked that all indicators and trade scenarios be deterministic local calculations, with AI limited to the final choice, probability judgment, and current-news context.

**How to apply:** Include local calculations, history status, and dated news cues; show whether history passed, failed, or lacks samples, and label all levels as conditional references rather than claiming historical qualification.

Do not label a Taiwan market-wide candidate “high win rate” because it hit the daily limit, surged, had high volume, or scored well technically. These are not measured win-rate evidence. Keep uncalibrated AI direction estimates separate from realized historical hit rates, visibly show the sample size and uncertainty, and make historical qualification status explicit. Let AI choose between validated direct-entry and pullback price scenarios; a sharp one-day rise rules out a direct chase, not the whole candidate.

**Why:** The user explicitly rejected treating limit-up moves as proof of a high win rate and asked for a readable, direct buy plan and an honest win-rate display.

**How to apply:** On the market-wide picks page, rank by AI's five-day upward estimate without a hard 60% cutoff, distinguish the research shortlist from historically validated high-win candidates, present one clear AI-selected conditional entry/stop/target plan, and never convert a price move or technical score into a claimed win rate.