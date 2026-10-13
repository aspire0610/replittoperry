import assert from "node:assert/strict";
import test from "node:test";
import { searchAssistantWeb } from "./assistant-web-search.ts";
import { parseDuckDuckGoSearchHtml } from "./duckduckgo-search.ts";
import { parseEtfDistributionHtml } from "./etf-distribution-data.ts";
import {
  answerTaiwanStockLotQuestion,
  isTaiwanBroadMarketQuestion,
  isTaiwanMarketActionFollowUp,
  isTaiwanStockActionQuestion,
  isTaiwanStockMovementReasonFollowUp,
  isTaiwanStockMovementReasonQuestion,
  isTaiwanStockQuoteQuestion,
  extractTaiwanStockSymbol,
  MAX_ASSISTANT_CHAT_ANSWER_LENGTH,
  parseAssistantChatOutput,
  shouldSearchWeb,
} from "./assistant-chat-utils.ts";

test("detects Taiwan broad-market questions without treating unrelated questions as market requests", () => {
  assert.equal(isTaiwanBroadMarketQuestion("今天台股大盤如何？"), true);
  assert.equal(isTaiwanBroadMarketQuestion("櫃買指數漲跌家數"), true);
  assert.equal(isTaiwanBroadMarketQuestion("即時行情"), true);
  assert.equal(isTaiwanBroadMarketQuestion("目前行情如何？"), true);
  assert.equal(isTaiwanBroadMarketQuestion("美股即時行情"), false);
  assert.equal(isTaiwanBroadMarketQuestion("台股交易時間是幾點？"), false);
  assert.equal(isTaiwanBroadMarketQuestion("寫一段旅行文案"), false);
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
  assert.equal(isTaiwanStockQuoteQuestion("台積電現在多少？"), true);
  assert.equal(isTaiwanStockActionQuestion("台積電建議怎麼操作？"), true);
  assert.equal(isTaiwanStockActionQuestion("2330 可以買進嗎？"), true);
  assert.equal(isTaiwanStockQuoteQuestion("今天台股大盤行情"), false);
  assert.equal(isTaiwanStockActionQuestion("寫一段旅行文案"), false);
  assert.equal(extractTaiwanStockSymbol("請看 2330.TW 的成交價"), "2330");
  assert.equal(extractTaiwanStockSymbol("請看 0050 的行情"), "0050");
  assert.equal(extractTaiwanStockSymbol("今天 2026 年的行情"), null);
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
    }],
    "test-request",
    "google_news_rss",
  );
  assert.equal(result.status, "searched");
  assert.match(result.summary, /Google News RSS/);
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
