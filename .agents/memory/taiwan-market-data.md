---
name: Taiwan market data provider behavior
description: Replit-specific upstream behavior observed while serving Taiwan stock quotes and history.
---

For Taiwan index and stock history, prefer official TWSE and TPEx sources. In this workspace, Node-side requests to Yahoo Finance have returned HTTP 429, while official exchange endpoints have returned real daily data. TWSE may also have transient connection failures, so keep a clear unavailable/error state rather than substituting generated prices.

TPEx historical `dailyQuotes` can return HTTP 200 headers quickly while its JSON body streams slowly or is interrupted. A 2025-12-09 response took about 30 seconds in one full read; a 12-second body timeout exhausted retries and was surfaced as invalid JSON, while a 45-second TPEx-specific timeout later parsed the same date successfully.

**Why:** Header arrival is not evidence that the complete report body is available; the endpoint's latency varied substantially during a real historical backtest.

**How to apply:** Give TPEx body reads a longer deadline than TWSE, distinguish timeouts from malformed JSON, and verify the full parsed response for the requested date before changing or replacing the official source.

Long official-history backfills can encounter transient TWSE HTTP 307 responses without a `Location` header and TPEx body connection resets, even when a standalone request succeeds. Do not let one exchange's failure cancel the other exchange's slower in-flight backfill.

**Why:** A backtest stopped after a transient TWSE failure while TPEx was still fetching; cancelling the peer discarded progress that could otherwise have been cached. A standalone request for the TWSE date later succeeded.

**How to apply:** Retry missing-location TWSE redirects with bounded exponential backoff, continue the other exchange and skip isolated failed dates, stop an exchange after repeated consecutive failures, and keep the backtest blocked until every required date is cached. Report missing dates so the next attempt resumes from cache.

On 2026-10-07, an authenticated full-market research request in the development preview was aborted after exactly 120 seconds while using a response that emitted nothing until completion. The UI should receive real AI-provider and per-day data progress, plus periodic heartbeats during slow official requests.

**Why:** The quiet JSON request looked frozen and ended with a generic client error; the logs did not establish whether the 120-second cutoff came from the browser, proxy, or another request deadline.

**How to apply:** Stream progress and keep the connection active for long research requests, but do not assume heartbeats remove any absolute runtime limit. Retain per-day cache writes so a disconnected client can safely retry.

TWSE MIS stock responses can have top-level `z: "-"` even when the latest trade is present under `trade.z` (observed for OTC stock 6488 on 2026-09-30). Requests should include `json=1`, `delay=0`, and a changing `_` cache-buster; otherwise intermediary caching can return a stale row.

**Why:** Provider access varies by runtime and can be intermittent; a fallback that hides source failure would make the dashboard's prices look authoritative when they are not.

**How to apply:** For MIS quotes, parse `z` first and then `trade.z`, and use the trade timestamp when available. Keep Yahoo Finance optional (for example, a futures quote only when it responds), label the actual provider, and expose missing data honestly.

TWSE MIS `getStockInfo.jsp` accepts pipe-delimited `ex_ch` channels: on 2026-10-20, a single 80-symbol TWSE request returned all 80 rows, and a mixed TWSE/TPEx request returned both `tse` and `otc` rows. Live rows expose trade time/price under `trade.t` / `trade.z`; `v` is cumulative volume in lots.

**Why:** Per-symbol requests do not scale to a live full-market scan, while batch responses can still contain stale, missing, or wrong-exchange rows that must not be treated as valid coverage.

**How to apply:** Use bounded batches and concurrency, match each row to its requested exchange and symbol, require explicit recent trade data, convert `v` from lots to shares, and report partial coverage when rows are missing.

Fugle stock snapshots can include a price and a recent `lastUpdated` value without an explicit last-trade timestamp. An update timestamp alone is not proof of a trade, especially outside Taiwan's regular session; prefer `lastTrade.time` and use official daily closes when an off-session response has no verifiable trade time.

**Why:** A pre-market 2330 response contained a price with a current update time but no explicit trade time. Treating that as a fresh transaction would misstate the last traded price.

**How to apply:** Preserve timestamp semantics at the API boundary. During regular trading, a fresh quote-update time may support a current quote; outside the session, only accept an explicitly timed trade as a last trade and otherwise show the official close.

For the full-market stock scan, use each stock's fresh traded price and cumulative session volume while the market is open. Outside the session, use that stock's latest traded historical daily bar. Compare intraday cumulative volume directly with 1.2× the prior 20-day average; the user chose this over projecting a full-day volume estimate.

**Why:** The user clarified that full-market scans must be real-time during trading and use the latest historical trade outside the session, then selected direct cumulative-volume comparison for the existing 1.2× gate.

**How to apply:** Require a timestamped in-session trade and volume for each stock during market hours; do not silently substitute a prior close. After hours, preserve the last historical bar's price, volume, source, and trade date.

Full-market fallback requests can exceed provider limits. Bounded TWSE/Fugle concurrency with `Retry-After` backoff eliminated observed HTTP 429s on the follow-up scan and recovered reference data for all 1,996 stocks. The remaining 196 histories lacked the 486-bar backtest window after FinMind 400 and Fugle 404 responses.

**Why:** Rate limiting was recoverable through pacing; provider 400/404 responses were not, so complete current references did not imply complete long histories.

**How to apply:** Bound and pace fallback lookups, honor retry headers/backoff, and report unresolved symbols. Do not retry 400/403/404 as if they were transient, and keep full-coverage gates until a verified source supplies aligned data.

FinMind v4 full-market `streaming_all_data` returned HTTP 403 with an earlier credential and HTTP 400 `Token is illegal` with a later replacement. After another secure replacement, the API accepted the token but returned `Your level is register. Please update your user level.` for the all-data request. A request without a token returned a generic free-level message and does not identify the account level associated with a configured token. The implementation uses FinMind's documented Bearer authorization.

**Why:** FinMind distinguishes an invalid token from an accepted token whose account level cannot access the all-market streaming endpoint.

**How to apply:** Verify the active token in Replit Secrets first; after the API accepts it, separately verify all-data streaming entitlement. Never retry 400/403 as transient, and keep the scan blocked rather than weakening coverage or backtest gates.

The official TWSE `STOCK_DAY_ALL` and TPEx `tpex_mainboard_quotes` daily reports include current actively quoted equities and ETFs with their security codes and names. These reports are useful for a cross-exchange active instrument catalog, unlike issuer registries that can omit fund tickers.

**Why:** Company/issuer master lists do not reliably enumerate ETF instruments, while the current daily security reports were verified to include active ETF codes alongside ordinary shares.

**How to apply:** Use both official daily reports for searchable current stock/ETF catalogs, preserve the source exchange on each code, cache the catalog for a bounded interval, and keep delisted or otherwise unavailable symbols out of the active suggestions.

The TWSE `STOCK_DAY_ALL` OpenAPI can lag TPEx's current daily report by a trading day even when the official TWSE `MI_INDEX` report already contains that day's complete closing quotes. On 2026-10-13, `STOCK_DAY_ALL` returned 2026-10-12 while `MI_INDEX` and TPEx both returned 2026-10-13. On 2026-10-20 after market close, both daily snapshot endpoints still returned 2026-10-19, while `MI_INDEX` had a validated 2026-10-20 closing report with 1,383 rows.

**Why:** Strict cross-exchange date checks correctly prevented a mixed-date LINE summary, but relying on one TWSE endpoint blocked a valid current-day close report.

**How to apply:** On a date mismatch, query official TWSE `MI_INDEX` for the other exchange's exact date. After market close, also query it for today's exact date when both snapshot endpoints lag. Accept it only when response status, report date, table schema, and a conservative minimum row count all validate; if TPEx remains stale, mark it unavailable and label the resulting scan partial.

For AI market-wide scans, one valid official exchange report can support a clearly marked partial scan when the other exchange or index history is temporarily unavailable. Do not label that result as complete Taiwan-market coverage; discard any exchange report whose trading date differs from the selected scan date.

**Why:** TWSE/TPEx endpoints can fail independently, and a strict all-or-nothing scan discarded valid data during a transient TPEx response failure.

**How to apply:** Keep strict completeness checks in APIs that require both exchanges. In the AI scanner only, track available exchanges and dates, report missing coverage in the result and UI, and require a useful minimum candidate pool before continuing.

TAIFEX's official daily futures report requires a page GET to establish a session, followed by a POST carrying the returned cookie. It provides a session's last price and trading date, but not the exact trade time.

**Why:** A direct POST without the page session did not return the report, and the report itself contains no precise last-trade timestamp.

**How to apply:** Keep the GET-cookie-POST sequence, use the report's trading date, label the price as a recent close with no exact trade time, and never treat it as a fresh strategy signal.

TAIFEX MIS also exposes an unauthenticated SockJS stream for Taiwan futures. Its initial quote snapshots arrive asynchronously across contracts, and the first message can belong to a farther expiry; use the exchange expiry date and wait for the initial snapshot before selecting the front month.

**Why:** A live integration test initially returned a farther contract because the stream delivered its quote before the nearer contracts.

**How to apply:** After connecting or reconnecting, collect the initial contract snapshots before choosing the nearest unexpired contract; keep the day and night session symbols distinct.

For TAIFEX night-session contracts (`-M`), `CDate` can remain on the prior trading date after midnight in Taiwan. When the exchange time is before 05:00, the quote belongs to the next local calendar date.

**Why:** Treating the trading date as the local date makes a valid post-midnight quote appear almost a day old and causes the freshness filter to discard it.

**How to apply:** Advance the local date only for post-midnight `-M` timestamps, preserve the exchange time as the actual trade time, and verify against the live stream during a night session.

TAIFEX rtCore messages after the initial snapshot can be sparse deltas that omit static contract metadata such as expiry (`222`) or the reference price (`129`). Retain a per-symbol snapshot and use actual price/time advancement—not SockJS heartbeats alone—to judge quote-stream health.

**Why:** Requiring every field on each message silently discards valid trades; a live heartbeat can then keep a stale quote connection open until a reconnect fetches another full snapshot.

**How to apply:** Merge incoming quote fields with the prior contract snapshot, preserve each delta's own trade price and timestamp, and reconnect if those values stop advancing while the socket remains open.

An unexpired TAIFEX contract's last official trade can remain useful after the 90-second live threshold or after a session closes. Do not discard a valid snapshot solely because it is stale; display it as the last trade with its source timestamp, never as live.

**Why:** Hiding every older quote made the futures card blank outside trading hours even when TAIFEX still provided a valid final trade snapshot, while substituting a current-looking value would be misleading.

**How to apply:** Keep contract-expiry and timestamp validation, distinguish live from last-trade status by quote age, and show the exact source trade time for both.

For the dashboard's futures quote cards, the user wants official last-close prices on exchange holidays and verified live prices on trading days.

**Why:** On holidays, the last close is useful context; on trading days, showing it instead of a live quote could mislead users.

**How to apply:** Detect weekends and official exchange holidays before fetching quotes. Show a dated official close only on those closed days; on trading days require a verified live source and show unavailable if it fails.

The verified TAIFEX quote fields provide last price, reference price, exchange date/time, and expiry. They do not establish intraday OHLC, volume, or order-book data. Until a separate intraday source is verified, futures guidance must stay conditional and direction-only; do not infer exact entry, stop, or target levels from last/reference prices or index daily bars.

**Why:** A last trade and a reference price cannot validate an intraday setup, and invented levels could be mistaken for executable trade guidance.

**How to apply:** Gate AI guidance on a fresh quote for the active session, keep night-session data as background only, and return wait/insufficient when the supporting intraday evidence is missing.

MOPS quarterly income-statement values are year-to-date through the reported quarter; balance-sheet values are period-end balances. Preserve this distinction in UI labels and AI context. TWSE T86's `外陸資買賣超股數(不含外資自營商)` excludes foreign proprietary dealers; add `外資自營商買賣超股數` for a foreign-investor total. TPEx daily investor net values and both exchanges' T86 values are shares; TPEx historical trading volume is in thousand shares and must be normalized to shares at the API boundary.

**Why:** These source-unit and period semantics are not interchangeable; treating cumulative earnings as a single quarter or mixing shares with thousand-shares changes the interpretation by a large factor.

**How to apply:** Keep the published period and units with every value. Use the official total-net field when available, and only combine subfields when the source labels establish which investors are excluded.

Fugle's index catalogue distinguishes `IR0001` (發行量加權股價報酬指數, total return) from `IX0001` (發行量加權股價指數, TAIEX price index). The earlier roughly 111,000-point `IR0001` readings were the wrong series for the dashboard's price-index quote; `IX0001` one-minute candles aligned with TWSE's prior close and live MIS quote on 2026-10-08.

**Why:** A valid timestamp and a well-formed candle do not ensure that a provider symbol represents the intended index.

**How to apply:** Use `IX0001` for TAIEX price quotes and intraday candles. Keep the 15% check against the official previous close before displaying Fugle index values.

Fugle's official FUTOPT documentation lists beta minute-candle REST and WebSocket channels for futures, including OHLC and volume. On 2026-10-01, this workspace's configured credential received HTTP 403 from the REST candle endpoint, and a direct WebSocket probe did not reach an authenticated candle response. Documentation availability does not establish that the deployed credential can access the data.

**Why:** An unentitled or unauthenticated data endpoint cannot support trustworthy AI entry prices, even when the provider documents the feature.

**How to apply:** Require a successful, timestamped live candle response for the active TXF contract before enabling exact AI entry prices. On access errors, keep entry prices unavailable and continue labeling TAIFEX's last day trade as a market reference only.

The official TAIFEX MIS public stream can provide timestamped last-trade updates for the front-month futures contract, but its published disclaimer says the data is informational and not intended for trading purposes. SinoPac Shioaji's official docs describe futures tick streaming and historical futures K-bars; using that route requires an authenticated account API key and certificate, neither of which is configured here.

**Why:** A technically reachable public quote feed is not automatically suitable for AI-generated trade entry levels; the source's stated use limits and the account's data entitlements matter.

**How to apply:** Keep TAIFEX MIS as a labeled market reference. Before using minute bars for AI entry suggestions, connect an authorized futures-data source such as the user's enabled broker API and verify its live timestamps and contract coverage. Never ask for broker credentials in chat; use the workspace secrets flow.

During Taiwan regular trading, the equity quote card may show a verified last trade that is 90 seconds to 3 minutes old, with its exact trade time and a clear non-real-time label. Older data falls back to the official close and explains that live sources are stale.

**Why:** The user chose this window to avoid hiding a recent trade immediately after the old 90-second cutoff without representing stale prices as current.

**How to apply:** Keep API and UI freshness rules aligned. Only an explicit trade timestamp (`成交時間`) qualifies for the 3-minute display window; a quote-update timestamp (`報價更新時間`) does not. Explain why the card falls back to the official close.

Do not wrap a serial live-quote plus fallback sequence in a shorter soft deadline than the full source path. Fugle and TWSE MIS requests can each take up to seven seconds, so a five-second caller timeout can discard the MIS fallback before it finishes.

**Why:** Individual-stock AI analysis returned no usable quote while its quote lookup was still progressing through the configured providers.

**How to apply:** Set the caller deadline to cover both bounded source attempts, and keep the three-minute verified-trade limit unchanged so a longer wait does not make stale data eligible.

For TSM ADR and the Philadelphia Semiconductor Index, Yahoo Finance chart requests returned HTTP 429 from the Node API runtime even though a Python shell probe succeeded. Nasdaq's public quote-info endpoint worked from Node. TSM includes a precise Eastern Time trade timestamp; SOX may provide only a trading date and is not marked real-time.

**Why:** A provider probe from a different runtime gave a false positive, and the index feed's date-only precision does not justify inventing an intraday timestamp.

**How to apply:** Verify market-data sources from the same runtime used by the API. Preserve Nasdaq's exact ET timestamp when supplied; for date-only quotes, show the source date without a fabricated time and keep the quote out of freshness decisions.

The configured Fugle stock-stream connection was rejected with `Maximum number of connections reached` while the dashboard API already held its own socket. The chosen design is one Reserved VM worker connection multiplexing stock aggregates and `IX0001`, with Vercel retrieving cached index quotes through the worker's authenticated HTTP relay.

**Why:** Fugle can reject an additional live socket for the same credential, so a separate alert worker cannot safely coexist with the API's direct stream.

**How to apply:** When the relay is deployed, set `LINE_WORKER_URL` in Vercel before relying on the worker; do not open a second Fugle stock socket from the production API. Keep development direct-stream behavior only when the worker URL is absent.

When Fugle has no current TAIEX minute candles, use only verified official historical minute bars as a fallback and explicitly mark the chart as historical with its session date and source time. Never synthesize or relabel old bars as live.

**Why:** Empty live candles occur outside active sessions and can also leave the dashboard blank; a historical session is useful only when its age is clear.

**How to apply:** Fall back only for an empty live-candle response, validate historical bars against the official prior close, and keep provider errors visible if historical data is also unavailable.

Fugle's historical-candles response is not the live intraday envelope: it may omit top-level `type` and has no top-level session `date`; its default order is descending. For historical index minutes, validate `symbol`, `exchange`, and `timeframe`, validate every candle's Taiwan-local session date, then sort ascending before applying chart checks.

**Why:** Reusing the live parser's envelope checks caused a valid historical response to fail and kept the dashboard's fallback at HTTP 502.

**How to apply:** Keep separate envelope parsing for the live and historical endpoints, and test historical payloads in Fugle's documented shape, including descending order and optional metadata.

On 2026-10-18, a multi-year TWSE daily-history request returned HTTP 403 in the scan while the shorter one-year TWSE request and Fugle's historical daily-candle API were reachable. Fugle limits each history request to less than one year.

**Why:** A 5-year monthly fan-out can be blocked even when enough recent history is available from a shorter official request or licensed market-data provider.

**How to apply:** When a 5-year official request fails, retry one year from the same exchange before using Fugle. If using Fugle, request at most 360 days, label the provider and actual coverage, and compare its latest date and close with the official market snapshot before including its bars in a scan backtest.

On 2026-10-18, live Fugle historical daily requests returned 242 bars for both `IX0001` and 2330.TW, covering 2025-10-17 through 2026-10-16. In the same scan, FinMind fallback requests returned HTTP 400 for 10 symbols; five symbols still had fewer than 60 usable long-history bars and were excluded from AI selection.

**Why:** A working fallback for the index and a large stock does not establish coverage for every symbol, and the FinMind endpoint was not reliable for all candidates.

**How to apply:** Keep official history first, label the actual provider and coverage per symbol, and validate the latest date and close before backtesting. Treat FinMind as best-effort until its HTTP 400 cases are understood; do not fill gaps with synthetic prices.

The user chose a per-stock official TWSE/TPEx and Fugle fallback for daily market scans when FinMind's full-market endpoint denies access. Keep request concurrency bounded, avoid retrying the denied FinMind bulk route per symbol, and accept recent history only when it has at least 21 ordered bars ending on the official scan date. The 24-month backtest still requires its full 486-bar window; exclude symbols that do not meet it and label partial scan coverage.

**Why:** the user selected a slower validated fallback instead of requiring a bulk-data entitlement or weakening the scan's history checks.

**How to apply:** Use the official daily universe, preserve each symbol's exchange, fall back through official per-stock history and Fugle, and never infer or synthesize missing bars.

On 2026-10-19, a live fallback scan matched recent daily history for 1,993 of 1,996 symbols: 1,123 from TWSE Open Data, 864 from TPEx Open Data, and 6 from Fugle. Three were excluded. The scan still had 427 symbols without the required 486-bar backtest window, logged long-history timeouts, and produced zero eligible AI candidates.

**Why:** Broad recent-history coverage only supports the current MA20/volume checks; it does not establish the full 24-month sample needed for strategy eligibility.

**How to apply:** Report recent coverage and 486-bar backtest eligibility separately. Keep the 10-settled-sample gate and describe a zero-pick scan as a valid result, not as fallback failure.

A cold `getTaiexSummary()` request took 13.1 seconds in the Node API runtime while fetching one year of official index history; a 4-second caller deadline incorrectly marked this optional context unavailable even though the route returned HTTP 200.

**Why:** Monthly TWSE history requests are bounded and concurrent, but the full cold one-year window can take substantially longer than a single request.

**How to apply:** Keep a finite summary deadline above the measured cold-path latency, preserve the non-blocking partial-context fallback, and avoid restarting AI workers just to probe this market-data path.

TWSE MIS `all_etf.txt` includes per-ETF market price (`e`), issuer-provided estimated NAV (`f`), and each record's date/time (`i`, `j`); `g` is the supplied premium percentage and `h` is prior NAV. The feed covers listed and OTC ETF codes, but record timestamps can differ.

**Why:** The official disclosure feed is separate from daily closing-price reports, and using a stale price beside a newer NAV can misstate the premium.

**How to apply:** Pair `e` and `f` from the same record, calculate amount as `e - f` and rate as `(e - f) / f * 100`, show that record's update time, and treat `f` as an issuer estimate rather than a final official NAV.