import assert from "node:assert/strict";
import test from "node:test";
import { searchAssistantWeb } from "./assistant-web-search.ts";
import { parseDuckDuckGoSearchHtml } from "./duckduckgo-search.ts";
import { parseEtfDistributionHtml } from "./etf-distribution-data.ts";
import {
  answerTaiwanStockLotQuestion,
  isTaiwanBroadMarketQuestion,
  isTaiwanMarketActionFollowUp,
  isTaiwanMarketForecastQuestion,
  isTaiwanMarketTimingQuestion,
  isTaiwanStockActionQuestion,
  isTaiwanStockContextFollowUp,
  isTaiwanStockRecommendationQuestion,
  isTaiwanStockMovementReasonFollowUp,
  isTaiwanStockMovementReasonQuestion,
  isTaiwanStockQuoteQuestion,
  mentionsTaiwanStockName,
  extractTaiwanStockSymbol,
  MAX_ASSISTANT_CHAT_ANSWER_LENGTH,
  parseAssistantChatOutput,
  shouldDispatchResearchAgents,
  shouldSearchWeb,
} from "./assistant-chat-utils.ts";
import { buildLineResearchSeatContext } from "./research-seat-context.ts";

test("LINE research seat context matches ticker/name and carries report date without using failed reports", () => {
  const context = buildLineResearchSeatContext(
    [{
      symbol: "00919",
      name: "群益台灣精選高息",
      mission: "追蹤配息與風險",
      reports: [
        { status: "failed", marketDate: null, asOf: "2026-10-19T00:00:00.000Z", answer: "timeout" },
        {
          status: "completed",
          marketDate: "2026-10-16",
          asOf: "2026-10-16T07:35:00.000Z",
          answer: "觀察配息來源與成分股集中風險。",
          assessment: { context: { sources: ["官方行情"] } },
        },
      ],
    }],
    "那它最近的研究報告呢？",
    [{ role: "user", content: "00919 近期配息與風險分析" }],
  );
  assert.match(context ?? "", /00919/u);
  assert.match(context ?? "", /2026-10-16/u);
  assert.match(context ?? "", /官方行情/u);
  assert.match(context ?? "", /最近一次執行：失敗/u);
  assert.doesNotMatch(context ?? "", /timeout/u);
});

test("LINE does not load an unrelated account's seat context", () => {
  const context = buildLineResearchSeatContext(
    [{
      symbol: "2330",
      name: "台積電",
      mission: "追蹤",
      reports: [{ status: "completed", marketDate: "2026-10-16", asOf: "2026-10-16T00:00:00.000Z", answer: "報告" }],
    }],
    "今天的天氣如何？",
    [],
  );
  assert.equal(context, null);
});

test("detects Taiwan broad-market questions without treating unrelated questions as market requests", () => {
  assert.equal(isTaiwanBroadMarketQuestion("今天台股大盤如何？"), true);
  assert.equal(isTaiwanBroadMarketQuestion("櫃買指數漲跌家數"), true);
  assert.equal(isTaiwanBroadMarketQuestion("即時行情"), true);
  assert.equal(isTaiwanBroadMarketQuestion("目前行情如何？"), true);
  assert.equal(isTaiwanBroadMarketQuestion("6223 盤勢分析"), false);
  assert.equal(isTaiwanBroadMarketQuestion("旺矽盤勢分析"), false);
  assert.equal(isTaiwanBroadMarketQuestion("台股盤勢分析"), true);
  assert.equal(isTaiwanBroadMarketQuestion("美股即時行情"), false);
  assert.equal(isTaiwanBroadMarketQuestion("台股交易時間是幾點？"), false);
  assert.equal(isTaiwanBroadMarketQuestion("寫一段旅行文案"), false);
});

test("recognizes Taiwan premarket and postmarket questions for market-data context", () => {
  assert.equal(isTaiwanMarketTimingQuestion("今天台股盤前怎麼看？"), true);
  assert.equal(isTaiwanMarketTimingQuestion("今日大盤盤後分析"), true);
  assert.equal(isTaiwanMarketTimingQuestion("盤前摘要"), true);
  assert.equal(isTaiwanMarketTimingQuestion("6223 盤後分析"), false);
  assert.equal(isTaiwanMarketTimingQuestion("旺矽盤後分析"), false);
  assert.equal(isTaiwanMarketTimingQuestion("美股盤前分析"), false);
  assert.equal(isTaiwanMarketTimingQuestion("台股交易時間是幾點？"), false);
});

test("recognizes next-session market direction questions and excludes ticker questions", () => {
  assert.equal(isTaiwanMarketForecastQuestion("明天開盤會漲嗎？"), true);
  assert.equal(isTaiwanMarketForecastQuestion("明天台股會漲嗎？"), true);
  assert.equal(isTaiwanMarketForecastQuestion("下個交易日台股偏多還是偏空？"), true);
  assert.equal(isTaiwanMarketForecastQuestion("下週大盤會漲還是跌？"), true);
  assert.equal(isTaiwanMarketForecastQuestion("開盤走勢"), true);
  assert.equal(isTaiwanMarketForecastQuestion("開盤趨勢怎麼看？"), true);
  assert.equal(isTaiwanMarketForecastQuestion("明天 2330 會漲嗎？"), false);
  assert.equal(isTaiwanMarketForecastQuestion("美股開盤走勢"), false);
  assert.equal(isTaiwanMarketForecastQuestion("台股會跟美股開盤走勢嗎？"), true);
  assert.equal(isTaiwanMarketForecastQuestion("明天會下雨嗎？"), false);
});

test("recognizes broad-market action follow-ups without confusing them with ticker questions", () => {
  assert.equal(
    isTaiwanMarketActionFollowUp("未來 5 天進場勝率？", ["下週台股會漲還是跌？"]),
    true,
  );
  assert.equal(
    isTaiwanMarketActionFollowUp("那有建議做法嗎？", ["下週大盤會怎麼走？"]),
    true,
  );
  assert.equal(
    isTaiwanMarketActionFollowUp("那有什麼餐廳建議？", ["下週大盤會怎麼走？"]),
    false,
  );
  assert.equal(
    isTaiwanMarketActionFollowUp("2330 未來 5 天進場勝率？", ["下週台股會漲還是跌？"]),
    false,
  );
  assert.equal(isTaiwanMarketActionFollowUp("未來 5 天進場勝率？", ["旅行建議"]), false);
});

test("detects Taiwan stock quote and action questions and extracts numeric tickers", () => {
  assert.equal(isTaiwanStockQuoteQuestion("台積電即時成交價"), true);
  assert.equal(isTaiwanStockQuoteQuestion("2330 現在股價多少？"), true);
  assert.equal(isTaiwanStockQuoteQuestion("2330 現在多少？"), true);
  assert.equal(isTaiwanStockQuoteQuestion("2330 即時行情"), true);
  assert.equal(isTaiwanStockQuoteQuestion("6223今日走勢"), true);
  assert.equal(isTaiwanStockQuoteQuestion("台積電現在多少？"), true);
  assert.equal(isTaiwanStockActionQuestion("台積電建議怎麼操作？"), true);
  assert.equal(isTaiwanStockActionQuestion("2330 可以買進嗎？"), true);
  assert.equal(isTaiwanStockActionQuestion("今天 2449 可以買嗎？"), true);
  assert.equal(isTaiwanStockActionQuestion("現在適合買 2449 嗎？"), true);
  assert.equal(isTaiwanStockActionQuestion("6223 盤勢分析"), true);
  assert.equal(isTaiwanStockActionQuestion("現在可以買嗎？"), true);
  assert.equal(isTaiwanStockActionQuestion("現在可以買 2330 嗎？"), true);
  assert.equal(isTaiwanStockActionQuestion("旺矽個股分析"), true);
  assert.equal(isTaiwanStockActionQuestion("台積電最近怎麼樣？"), true);
  assert.equal(isTaiwanStockActionQuestion("旺矽表現如何？"), true);
  assert.equal(isTaiwanStockQuoteQuestion("今天台股大盤行情"), false);
  assert.equal(isTaiwanStockActionQuestion("寫一段旅行文案"), false);
  assert.equal(extractTaiwanStockSymbol("請看 2330.TW 的成交價"), "2330");
  assert.equal(extractTaiwanStockSymbol("請看 0050 的行情"), "0050");
  assert.equal(extractTaiwanStockSymbol("今天 2026 年的行情"), null);
});

test("resolves common company aliases and natural follow-up wording", () => {
  assert.equal(
    mentionsTaiwanStockName(
      "台積電最近怎麼樣？",
      "台灣積體電路製造股份有限公司",
      "2330",
    ),
    true,
  );
  assert.equal(
    mentionsTaiwanStockName("旺矽建議操作", "旺矽科技股份有限公司", "6223"),
    true,
  );
  assert.equal(
    mentionsTaiwanStockName("科技股怎麼看", "旺矽科技股份有限公司", "6223"),
    false,
  );
  assert.equal(isTaiwanStockContextFollowUp("那它現在可以買嗎？"), true);
  assert.equal(isTaiwanStockContextFollowUp("這檔最近表現呢？"), true);
  assert.equal(isTaiwanStockContextFollowUp("附近有什麼餐廳？"), false);
});

test("recognizes natural-language requests for short-horizon Taiwan stock picks", () => {
  for (const question of [
    "推薦幾支未來幾天會漲的股票",
    "推薦未來幾天會漲能賺錢的股票",
    "接下來一週買哪支台股？",
    "幫我選股",
    "找幾檔個股",
  ]) {
    assert.equal(isTaiwanStockRecommendationQuestion(question), true, question);
  }
  assert.equal(isTaiwanStockRecommendationQuestion("推薦台北餐廳"), false);
});

test("detects stock-movement cause questions and triggers current web research", () => {
  for (const question of [
    "2330 為什麼今天下跌",
    "台積電上漲原因",
    "為何 0050 最近走高？",
    "聯發科怎麼回事，今天大跌嗎？",
  ]) {
    assert.equal(isTaiwanStockMovementReasonQuestion(question), true, question);
    assert.equal(shouldSearchWeb(question), true, question);
  }
  assert.equal(isTaiwanStockMovementReasonQuestion("台積電目前股價多少？"), false);
  assert.equal(
    isTaiwanStockMovementReasonFollowUp("為什麼呢？", ["2330 今天下跌"]),
    true,
  );
  assert.equal(
    isTaiwanStockMovementReasonFollowUp("那原因呢？", ["台積電今天上漲"]),
    true,
  );
  assert.equal(isTaiwanStockMovementReasonFollowUp("為什麼呢？", ["你好"]), false);
  assert.equal(shouldSearchWeb("你好"), false);
});

test("extracts safe DuckDuckGo result links and snippets", () => {
  const html = `
    <div class="result results_links results_links_deep web-result">
      <div class="links_main">
        <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.stat.gov.tw%2FCPI.aspx&amp;rut=abc">中華民國統計資訊網</a></h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.stat.gov.tw%2FCPI.aspx&amp;rut=abc">115年8月消費者物價指數 (CPI) 年增率漲 2.04％</a>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result">
      <div class="links_main">
        <h2><a class="result__a" href="https://example.org/research">Research page</a></h2>
        <a class="result__snippet" href="https://example.org/research">A second result &amp; its summary.</a>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result">
      <div class="links_main">
        <h2><a class="result__a" href="javascript:alert(1)">Unsafe result</a></h2>
        <a class="result__snippet">This result must be discarded.</a>
      </div>
    </div>`;

  assert.deepEqual(parseDuckDuckGoSearchHtml(html), [
    {
      title: "中華民國統計資訊網",
      url: "https://www.stat.gov.tw/CPI.aspx",
      snippet: "115年8月消費者物價指數 (CPI) 年增率漲 2.04％",
    },
    {
      title: "Research page",
      url: "https://example.org/research",
      snippet: "A second result & its summary.",
    },
  ]);
});

test("labels Google News RSS search results and preserves their source links", async () => {
  const result = await searchAssistantWeb(
    "台股近期新聞",
    async () => [{
      title: "測試新聞",
      url: "https://news.google.com/rss/articles/example",
      snippet: "公開 RSS 摘要",
      publishedAt: "2026-10-21T02:00:00.000Z",
    }],
    "test-request",
    "google_news_rss",
  );
  assert.equal(result.status, "searched");
  assert.match(result.summary, /Google News RSS/);
  assert.match(result.summary, /發布時間/u);
  assert.match(result.summary, /台灣時間/u);
  assert.equal(result.provider, "google_news_rss");
  assert.equal(result.sources[0].url, "https://news.google.com/rss/articles/example");
});

test("includes search-provider attribution and sources in assistant web results", async () => {
  const result = await searchAssistantWeb(
    "00919 今天為何上漲",
    async () => [{
      title: "近期消息",
      url: "https://example.org/news",
      snippet: "搜尋摘要內容",
    }],
  );
  assert.equal(result.status, "searched");
  assert.match(result.summary, /DuckDuckGo/);
  assert.equal(result.sources[0]?.url, "https://example.org/news");
  assert.equal(result.provider, "duckduckgo");
  assert.equal(result.diagnostic.provider, "duckduckgo");
  const braveResult = await searchAssistantWeb(
    "00919 最新消息",
    async () => [{
      title: "市場消息",
      url: "https://example.org/brave-news",
      snippet: "摘要",
    }],
    undefined,
    "brave",
  );
  assert.match(braveResult.summary, /Brave Search/);
  assert.equal(braveResult.provider, "brave");
  assert.equal(braveResult.diagnostic.provider, "brave");
  const searxngResult = await searchAssistantWeb(
    "00919 最新消息",
    async () => [{
      title: "SearXNG 市場消息",
      url: "https://example.org/searxng-news",
      snippet: "摘要",
    }],
    undefined,
    "searxng",
  );
  assert.match(searxngResult.summary, /SearXNG/);
  assert.equal(searxngResult.provider, "searxng");
});

test("does not use paid search fallback when DuckDuckGo fails", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Unexpected network request");
  };
  try {
    const result = await searchAssistantWeb(
      "00919 今天為何上漲",
      async () => { throw new Error("DuckDuckGo was blocked"); },
      "test-request",
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.summary, null);
    assert.deepEqual(result.sources, []);
    assert.equal(result.provider, null);
    assert.deepEqual(result.diagnostic, {
       provider: "duckduckgo",
      outcome: "failed",
      failureKind: "network_error",
    });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("records DuckDuckGo HTTP failures without retaining provider error text", async () => {
  const result = await searchAssistantWeb(
    "00919 今天為何上漲",
    async () => { throw new Error("DuckDuckGo search returned HTTP 429"); },
    "test-request",
  );
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.diagnostic, {
    provider: "duckduckgo",
    outcome: "failed",
    failureKind: "http_error",
    httpStatus: 429,
  });
});

test("records an empty DuckDuckGo response as an empty result", async () => {
  const result = await searchAssistantWeb("00919 今天為何上漲", async () => []);
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.diagnostic, {
    provider: "duckduckgo",
    outcome: "empty",
    resultCount: 0,
  });
});

test("uses Google News RSS when a stock-cause search returns no DuckDuckGo results", async () => {
  const calls = [];
  const question = "旺矽 6223 股價漲跌原因";
  const result = await searchAssistantWeb(
    question,
    async (query) => {
      calls.push("duckduckgo");
      assert.equal(query, question);
      return [];
    },
    "test-request",
    "duckduckgo",
    {
      provider: "google_news_rss",
      webSearch: async (query) => {
        calls.push("google_news_rss");
        assert.equal(query, question);
        return [{
          title: "旺矽相關新聞",
          url: "https://news.google.com/rss/articles/example",
          snippet: "測試用新聞摘要",
        }];
      },
    },
  );

  assert.deepEqual(calls, ["duckduckgo", "google_news_rss"]);
  assert.equal(result.status, "searched");
  assert.equal(result.provider, "google_news_rss");
  assert.match(result.summary, /Google News RSS/);
  assert.deepEqual(result.diagnostic, {
    provider: "google_news_rss",
    outcome: "searched",
    resultCount: 1,
    attempts: [
      { provider: "duckduckgo", outcome: "empty", resultCount: 0 },
      { provider: "google_news_rss", outcome: "searched", resultCount: 1 },
    ],
  });
});

test("keeps both safe search diagnostics when DuckDuckGo fails and RSS is empty", async () => {
  const result = await searchAssistantWeb(
    "旺矽 6223 股價漲跌原因",
    async () => { throw new Error("DuckDuckGo search returned HTTP 403"); },
    "test-request",
    "duckduckgo",
    { provider: "google_news_rss", webSearch: async () => [] },
  );

  assert.equal(result.status, "unavailable");
  assert.equal(result.summary, null);
  assert.deepEqual(result.diagnostic, {
    provider: "google_news_rss",
    outcome: "empty",
    resultCount: 0,
    attempts: [
      {
        provider: "duckduckgo",
        outcome: "failed",
        failureKind: "http_error",
        httpStatus: 403,
      },
      { provider: "google_news_rss", outcome: "empty", resultCount: 0 },
    ],
  });
});

test("reads ETF distributions from official-style table rows without turning blank amounts into zero", () => {
  const html = `
    <table><tbody>
      <tr><td>009803</td><td>玉山臺灣市值動能 50 ETF</td>
        <td>115年09月15日</td><td>115年09月17日</td>
        <td>115年10月12日</td><td>0.9</td><td>詳細資料</td><td>115</td></tr>
      <tr><td>009803</td><td>玉山臺灣市值動能 50 ETF</td>
        <td>115年06月15日</td><td>115年06月21日</td>
        <td>115年07月07日</td><td></td><td>詳細資料</td><td>115</td></tr>
      <tr><td>0050</td><td>Other ETF</td>
        <td>115年07月21日</td><td>115年07月25日</td>
        <td>115年08月10日</td><td>1.0</td><td>詳細資料</td><td>115</td></tr>
    </tbody></table>`;
  const result = parseEtfDistributionHtml(
    html,
    "009803",
    "https://www.twse.com.tw/zh/ETFortune-institute/dividendList",
    "2026-10-06T12:00:00.000Z",
  );

  assert.equal(result.status, "available");
  assert.equal(result.fundName, "玉山臺灣市值動能 50 ETF");
  assert.deepEqual(result.records, [
    {
      exDividendDate: "2026-09-15",
      paymentDate: "2026-10-12",
      cashAmountPerUnit: 0.9,
      announcedYear: 2026,
    },
    {
      exDividendDate: "2026-06-15",
      paymentDate: "2026-07-07",
      cashAmountPerUnit: null,
      announcedYear: 2026,
    },
  ]);
});

test("does not report unavailable or malformed distributions as valid records", () => {
  const result = parseEtfDistributionHtml(
    `<table><tbody><tr><td>009803</td><td>ETF</td><td>115年02月30日</td><td>115年03月05日</td><td>115年03月10日</td><td>0.2</td><td>詳細資料</td><td>115</td></tr></tbody></table>`,
    "009803",
    "https://www.twse.com.tw/zh/ETFortune-institute/dividendList",
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.records.length, 0);
});

test("web lookup follows current-information needs rather than small talk or creative prompts", () => {
  assert.equal(shouldSearchWeb("009803 今年配息多少？"), true);
  assert.equal(shouldSearchWeb("What is the latest Taiwan CPI?"), true);
  assert.equal(shouldSearchWeb("你好"), false);
  assert.equal(shouldSearchWeb("幫我寫一首關於下雨的詩"), false);
});

test("only detailed research requests dispatch CEO research employees", () => {
  assert.equal(shouldDispatchResearchAgents("台股6223近期短線分析"), true);
  assert.equal(shouldDispatchResearchAgents("6223 可以買進嗎？"), true);
  assert.equal(shouldDispatchResearchAgents("比較 0050 和 006208 的風險"), true);
  assert.equal(shouldDispatchResearchAgents("00919 這兩天想要補倉"), true);
  assert.equal(shouldDispatchResearchAgents("研究最近半導體產業趨勢"), true);
  assert.equal(shouldDispatchResearchAgents("你好"), false);
  assert.equal(shouldDispatchResearchAgents("0050 現在價格多少？"), false);
  assert.equal(shouldDispatchResearchAgents("台股 1 張等於幾股？"), false);
  assert.equal(shouldDispatchResearchAgents("幫我寫一首雨天的詩"), false);
});

test("assistant answers are valid JSON, concise, and capped", () => {
  const answer = "配息總額是每單位 0.9 元，除息日為 9 月 15 日。";
  assert.equal(
    parseAssistantChatOutput(JSON.stringify({ answer })),
    answer,
  );
  assert.equal(
    parseAssistantChatOutput(
      `\`\`\`json\n${JSON.stringify({ answer })}\n\`\`\``,
    ),
    answer,
  );
  assert.equal(
    parseAssistantChatOutput(
      JSON.stringify({ answer: "超長".repeat(MAX_ASSISTANT_CHAT_ANSWER_LENGTH) }),
    ),
    null,
  );
  assert.equal(parseAssistantChatOutput("not json"), null);
});

test("Taiwan stock lot conversions use the fixed 1,000-share unit", () => {
  assert.equal(
    answerTaiwanStockLotQuestion("台股 1 張等於幾股？"),
    "台灣上市櫃股票 1 張 = 1,000 股；不足 1,000 股為零股。其他市場或商品的單位可能不同。",
  );
  assert.equal(
    answerTaiwanStockLotQuestion("1張股票100股"),
    "台灣上市櫃股票 1 張 = 1,000 股；不足 1,000 股為零股。其他市場或商品的單位可能不同。",
  );
  assert.equal(
    answerTaiwanStockLotQuestion("台股 5 張要換算成幾股？"),
    "台灣上市櫃股票 1 張 = 1,000 股；5 張 = 5,000 股。其他市場或商品的單位可能不同。",
  );
  assert.equal(
    answerTaiwanStockLotQuestion("1,500 股等於幾張？"),
    "1,500 股 = 1 張 + 500 股零股（合計 1.5 張）。台灣上市櫃股票 1 張 = 1,000 股。",
  );
  assert.equal(
    answerTaiwanStockLotQuestion("美股 1 張等於幾股？"),
    null,
  );
  assert.equal(
    answerTaiwanStockLotQuestion("買了 1 張股票，股價會漲多少？"),
    null,
  );
});
