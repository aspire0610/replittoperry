---
name: LINE assistant experience
description: Product expectations for stock-specific LINE answers and closing-summary readability.
---

For stock-specific LINE questions, include the verified quote with source/time and a concise AI explanation plus explicit action direction. Resolve natural company-name aliases and recent stock follow-ups from conversation history so users do not need to repeat a clear target. Query available official/search sources before saying data is unavailable; answer verified portions and state only the specific unresolved limitation. Do not let the broad-market "盤勢" classifier intercept an individual stock code or company name. Keep post-close summaries concise, use short section labels, and visually separate index interpretation from watchlist closes. The LINE post-close AI summary should use the same closing-mode summary source as the homepage so the main analysis does not diverge between channels.

For individual-stock movement-cause questions, LINE and the web CEO should use the same bounded primary-plus-fallback search behavior. Premarket and closing LINE summaries must include concrete market evidence and clickable data/news sources; label news as unverified when only search snippets are available, and identify the actual index-history provider rather than implying every fallback is official.

**Why:** The user reported that LINE should handle stock questions as natural conversation, search available data before claiming it is missing, and give accurate evidence-based answers rather than generic unavailable responses. They also reported that the closing summary was crowded on mobile and that LINE's closing-summary content differed from the homepage.

**How to apply:** Test code- and company-name prompts such as "6223 盤勢分析", natural questions such as "台積電最近怎麼樣", and follow-ups such as "那它呢". Preserve the AI's validated action and evidence, and keep source/time context with the quote. Use the same closing-mode market-summary function for the homepage and LINE; keep restrained labels and spacing in the LINE post-close message without removing dates, sources, or risk context.

Format every LINE answer with readable section spacing; show long source URLs only as compact clickable titles. CEO and LINE stock-action replies should lead with a decisive buy / do-not-buy / insufficient-data conclusion, show a buy price only when a complete plan passes validation, and state the concrete reason when the answer is no-buy.

**Why:** The user reported that crowded LINE summaries and complex links were hard to read, and explicitly asked CEO and LINE answers to say whether a stock can be bought, at what validated price, or why it cannot be bought.

**How to apply:** Apply the shared LINE formatter to conversational and scheduled summary replies. Keep source URLs in LINE URI actions rather than inline message text, and use only the stock assistant's validated plan for action prices.
