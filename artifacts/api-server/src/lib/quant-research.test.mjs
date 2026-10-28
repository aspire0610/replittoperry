import assert from "node:assert/strict";
import test from "node:test";
import {
  isFundOrEtf,
  parseTpexDailyMarket,
  parseTwseDailyMarket,
} from "./quant-market-parse.ts";
import {
  calculateQuantBacktest,
  normalizeFactorWeights,
} from "./quant-backtest.ts";
import { parseRecurringContribution } from "./quant-recurring-investment.ts";
import {
  matchesQuantSignalRule,
  parseQuantSignalRule,
} from "./quant-signal-rules.ts";
import {
  normalizeQuantTickerFilter,
  resolveQuantTickerFilter,
} from "./quant-ticker-filter.ts";
import { fetchOfficialJson } from "./official-json-fetch.ts";
import {
  calculateMonteCarloRisk,
  createWalkForwardWindows,
} from "./quant-validation.ts";

test("creates expanding walk-forward windows without overlapping validation periods", () => {
  const dates = Array.from({ length: 80 }, (_, index) =>
    new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
  );
  const folds = createWalkForwardWindows(dates, 3);
  assert.equal(folds.length, 3);
  assert.equal(folds[0].trainEndDate, dates[19]);
  assert.equal(folds[0].validationStartDate, dates[20]);
  assert.equal(folds[1].trainEndDate, dates[39]);
  assert.equal(folds[1].validationStartDate, dates[40]);
  assert.equal(folds[2].trainEndDate, dates[59]);
  assert.equal(folds[2].validationEndDate, dates.at(-1));
});

test("bootstraps reproducible Monte Carlo summaries from out-of-sample daily returns", () => {
  const curve = Array.from({ length: 31 }, (_, index) => ({
    equity: 100_000 * (1 + (index % 2 === 0 ? 0.002 : -0.001)),
  }));
  const first = calculateMonteCarloRisk([curve], "seed", 500);
  const second = calculateMonteCarloRisk([curve], "seed", 500);
  assert.deepEqual(first, second);
  assert.equal(first.simulationCount, 500);
  assert.equal(first.sampledSessions, 30);
  assert.equal(first.terminalReturnBuckets.reduce((sum, bucket) => sum + bucket.count, 0), 500);
  assert.ok(first.probabilityOfLossPercent !== null);
});

test("does not publish Monte Carlo estimates with fewer than 20 observations", () => {
  const result = calculateMonteCarloRisk([Array.from({ length: 10 }, (_, index) => ({ equity: 100 + index }))], "short");
  assert.equal(result.simulationCount, 0);
  assert.equal(result.probabilityOfLossPercent, null);
  assert.equal(result.sampledSessions, 9);
});

test("follows redirects between approved official exchange hosts", async () => {
  const requests = [];
  const responses = [
    new Response(null, {
      status: 307,
      headers: {
        location:
          "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json",
      },
    }),
    new Response(JSON.stringify({ stat: "OK" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ];
  const fakeFetch = async (url, init) => {
    requests.push({
      url: String(url),
      redirect: init.redirect,
      headers: init.headers,
    });
    return responses.shift();
  };

  const payload = await fetchOfficialJson(
    new URL("https://twse.com.tw/rwd/zh/afterTrading/MI_INDEX"),
    "twse",
    "2026-10-07",
    fakeFetch,
  );

  assert.deepEqual(payload, { stat: "OK" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].redirect, "manual");
  assert.equal(
    requests[0].headers.Referer,
    "https://www.twse.com.tw/zh/",
  );
  assert.equal(requests[0].headers["X-Requested-With"], "XMLHttpRequest");
  assert.match(requests[1].url, /^https:\/\/www\.twse\.com\.tw\//);
});

test("does not follow or retry redirects away from official exchange hosts", async () => {
  let requestCount = 0;
  const fakeFetch = async () => {
    requestCount += 1;
    return new Response(null, {
      status: 307,
      headers: { location: "https://example.com/not-an-exchange" },
    });
  };

  await assert.rejects(
    fetchOfficialJson(
      new URL("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"),
      "twse",
      "2026-10-07",
      fakeFetch,
    ),
    /redirected to a non-official host/,
  );
  assert.equal(requestCount, 1);
});

test("retries a temporary 307 without a Location header", async () => {
  let requestCount = 0;
  const delays = [];
  const retryAttempts = [];
  const fakeFetch = async () => {
    requestCount += 1;
    if (requestCount < 5) {
      return new Response(null, { status: 307 });
    }
    return new Response(JSON.stringify({ stat: "OK" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const payload = await fetchOfficialJson(
    new URL("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"),
    "twse",
    "2026-02-26",
    fakeFetch,
    undefined,
    {
      sleep: async (milliseconds) => delays.push(milliseconds),
      onRetry: (retry) => retryAttempts.push(retry.nextAttempt),
    },
  );

  assert.deepEqual(payload, { stat: "OK" });
  assert.equal(requestCount, 5);
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
  assert.deepEqual(retryAttempts, [2, 3, 4, 5]);
});

test("bounds repeated TWSE 307 responses without a Location header", async () => {
  let requestCount = 0;
  const delays = [];
  const fakeFetch = async () => {
    requestCount += 1;
    return new Response(null, { status: 307 });
  };

  await assert.rejects(
    fetchOfficialJson(
      new URL("https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"),
      "twse",
      "2026-02-26",
      fakeFetch,
      undefined,
      { sleep: async (milliseconds) => delays.push(milliseconds) },
    ),
    /failed after 5 attempts: TWSE 2026-02-26 returned HTTP 307 without a Location header/,
  );

  assert.equal(requestCount, 5);
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
});

test("bounds TPEx retries and keeps the failing date in the error", async () => {
  let requestCount = 0;
  const fakeFetch = async () => {
    requestCount += 1;
    throw new Error("upstream timeout");
  };

  await assert.rejects(
    fetchOfficialJson(
      new URL("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes"),
      "tpex",
      "2025-12-09",
      fakeFetch,
      undefined,
      { sleep: async () => undefined },
    ),
    /TPEx 2025-12-09 official daily data request failed after 3 attempts: upstream timeout/,
  );
  assert.equal(requestCount, 3);
});

test("reports TPEx body connection resets separately from invalid JSON", async () => {
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: null,
    json: async () => {
      throw new TypeError("terminated: other side closed");
    },
  });

  await assert.rejects(
    fetchOfficialJson(
      new URL("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes"),
      "tpex",
      "2025-12-12",
      fakeFetch,
    ),
    /TPEx 2025-12-12 response body connection was interrupted/,
  );
});

test("stops retrying an exchange request when the range is cancelled", async () => {
  const controller = new AbortController();
  let requestCount = 0;
  const fakeFetch = async () => {
    requestCount += 1;
    controller.abort(new Error("another exchange failed"));
    throw new Error("request aborted");
  };

  await assert.rejects(
    fetchOfficialJson(
      new URL("https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes"),
      "tpex",
      "2025-12-12",
      fakeFetch,
      controller.signal,
    ),
    /request aborted/,
  );
  assert.equal(requestCount, 1);
});

test("TWSE parser maps official price, turnover, volume, and index fields", () => {
  const result = parseTwseDailyMarket(
    {
      date: "20261006",
      stat: "OK",
      tables: [
        {
          title: "每日收盤行情",
          data: [
            [
              "2330",
              "台積電",
              "1,000",
              "200",
              "980,000",
              "980.00",
              "990.00",
              "975.00",
              "988.00",
            ],
            ["0050", "元大台灣50", "1,000", "10", "N/A", "N/A", "N/A", "N/A", "N/A"],
          ],
        },
        {
          title: "大盤統計資訊",
          data: [["發行量加權股價指數", "27,500.25"]],
        },
      ],
    },
    "2026-10-06",
    "https://www.twse.com.tw/test",
  );

  assert.equal(result.exchange, "twse");
  assert.equal(result.quotes.length, 1);
  assert.equal(result.quotes[0].ticker, "2330.TW");
  assert.equal(result.quotes[0].turnover, 980000);
  assert.equal(result.quotes[0].volume, 1000);
  assert.equal(result.benchmarkClose, 27500.25);
});

test("TPEx parser requires the slash-form date in the response and maps its quote rows", () => {
  const result = parseTpexDailyMarket(
    {
      date: "20261006",
      stat: "ok",
      tables: [
        {
          title: "上櫃股票行情",
          data: [
            [
              "6488",
              "環球晶",
              "410.00",
              "+2.00",
              "408.00",
              "415.00",
              "405.00",
              "410.25",
              "12,345",
              "5,050,000",
            ],
          ],
        },
      ],
    },
    "2026-10-06",
    "https://www.tpex.org.tw/test",
  );

  assert.equal(result.quotes[0].ticker, "6488.TWO");
  assert.equal(result.quotes[0].open, 408);
  assert.equal(result.quotes[0].close, 410);
  assert.equal(result.quotes[0].turnover, 5050000);
  assert.equal(result.benchmarkClose, null);
});

test("TWSE non-trading-day response becomes an explicit empty snapshot", () => {
  const result = parseTwseDailyMarket(
    { stat: "很抱歉，沒有符合條件的資料!" },
    "2026-10-10",
    "https://www.twse.com.tw/test",
  );

  assert.equal(result.date, "2026-10-10");
  assert.deepEqual(result.quotes, []);
  assert.equal(result.benchmarkClose, null);
});

test("parsers reject mismatched dates and invalid OHLC values", () => {
  assert.throws(
    () =>
      parseTpexDailyMarket(
        { date: "20261005", tables: [{ data: [] }] },
        "2026-10-06",
        "https://www.tpex.org.tw/test",
      ),
    /date did not match/,
  );

  const invalid = parseTwseDailyMarket(
    {
      date: "20261006",
      stat: "OK",
      tables: [
        {
          title: "每日收盤行情",
          data: [
            [
              "2330",
              "台積電",
              "1,000",
              "200",
              "980,000",
              "1,000",
              "990",
              "975",
              "988",
            ],
          ],
        },
      ],
    },
    "2026-10-06",
    "https://www.twse.com.tw/test",
  );
  assert.deepEqual(invalid.quotes, []);
});

function makeSnapshots() {
  const dates = [];
  const cursor = new Date("2025-01-01T00:00:00.000Z");
  while (dates.length < 180) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates.map((date, index) => {
    const stock2330Close = 100 + index * 1.25;
    const stock1101Close = 45 + (index % 7) * 0.08;
    const otc6488Close = 70 + index * 0.55;
    const quote = (
      symbol,
      ticker,
      name,
      exchange,
      close,
      turnover = 12_000_000,
    ) => ({
      symbol,
      ticker,
      name,
      exchange,
      open: close * 0.999,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 10_000,
      turnover,
    });
    return [
      {
        date,
        exchange: "twse",
        quotes: [
          quote("2330", "2330.TW", "台積電", "twse", stock2330Close, 100_000_000),
          quote("1101", "1101.TW", "台泥", "twse", stock1101Close, 30_000_000),
        ],
        benchmarkClose: 20_000 + index * 12,
        source: "test",
        sourceUrl: "https://example.com/twse",
      },
      {
        date,
        exchange: "tpex",
        quotes: [
          quote("6488", "6488.TWO", "環球晶", "tpex", otc6488Close, 45_000_000),
        ],
        benchmarkClose: null,
        source: "test",
        sourceUrl: "https://example.com/tpex",
      },
    ];
  }).flat();
}

const ALWAYS_ENTER = {
  mode: "all",
  conditions: [{ factor: "momentum20", operator: "gte", threshold: -0.99 }],
};
const NEVER_EXIT = {
  mode: "all",
  conditions: [{ factor: "momentum20", operator: "lte", threshold: -0.99 }],
};

function makeSignalSnapshots() {
  const snapshots = [];
  const cursor = new Date("2025-01-01T00:00:00.000Z");
  let index = 0;
  while (snapshots.length < 180) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      let close = 100;
      if (index >= 80 && index < 100) close = 100 + (index - 79);
      else if (index >= 100 && index < 120) close = 120;
      else if (index >= 120 && index < 140) close = 120 - (index - 119) * 2;
      else if (index >= 140) close = 80;

      const date = cursor.toISOString().slice(0, 10);
      snapshots.push({
        date,
        exchange: "twse",
        quotes: [
          {
            symbol: "2330",
            ticker: "2330.TW",
            name: "台積電",
            exchange: "twse",
            open: close,
            high: close * 1.01,
            low: close * 0.99,
            close,
            volume: 100_000,
            turnover: close * 100_000,
          },
        ],
        benchmarkClose: 20_000 + index * 5,
        source: "test",
        sourceUrl: "https://example.com/twse",
      });
      index += 1;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return snapshots;
}

test("factor weights normalize to one and invalid weights fail explicitly", () => {
  const normalized = normalizeFactorWeights({
    momentum20: 0.4,
    momentum60: 0.2,
    liquidity20: 0.2,
    lowVolatility20: 0.2,
  });
  assert.equal(
    Object.values(normalized).reduce((sum, weight) => sum + weight, 0),
    1,
  );
  assert.throws(
    () =>
      normalizeFactorWeights({
        momentum20: 0,
        momentum60: 0,
        liquidity20: 0,
        lowVolatility20: 0,
      }),
    /權重無效/,
  );
  assert.equal(isFundOrEtf("0050"), true);
  assert.equal(isFundOrEtf("2330"), false);
});

test("signal-rule validation and matching enforce factor-specific directions", () => {
  const entryRule = {
    mode: "all",
    conditions: [
      { factor: "momentum20", operator: "gte", threshold: 0.05 },
      { factor: "volatility20", operator: "lte", threshold: 0.03 },
    ],
  };
  const parsedEntry = parseQuantSignalRule(entryRule, "entry");
  assert.deepEqual(parsedEntry, entryRule);
  assert.equal(
    matchesQuantSignalRule(parsedEntry, {
      momentum20: 0.08,
      momentum60: 0.1,
      liquidity20: 100_000_000,
      volatility20: 0.02,
    }),
    true,
  );
  assert.equal(
    matchesQuantSignalRule(parsedEntry, {
      momentum20: 0.08,
      momentum60: 0.1,
      liquidity20: 100_000_000,
      volatility20: 0.04,
    }),
    false,
  );
  assert.equal(
    parseQuantSignalRule(
      {
        mode: "all",
        conditions: [
          { factor: "momentum20", operator: "lte", threshold: 0 },
        ],
      },
      "entry",
    ),
    null,
  );
  assert.equal(
    parseQuantSignalRule(
      {
        mode: "any",
        conditions: [
          { factor: "momentum20", operator: "gte", threshold: 0.05 },
          { factor: "momentum20", operator: "gte", threshold: 0.1 },
        ],
      },
      "entry",
    ),
    null,
  );
});

test("normalizes and resolves an optional single-stock filter", () => {
  const snapshots = makeSnapshots();
  assert.equal(normalizeQuantTickerFilter(undefined), null);
  assert.equal(normalizeQuantTickerFilter(" 2330 "), "2330");
  assert.equal(normalizeQuantTickerFilter("2330.tw"), "2330.TW");
  assert.throws(
    () => normalizeQuantTickerFilter("台積電"),
    /股票代碼格式不正確/,
  );
  assert.equal(
    resolveQuantTickerFilter("2330", snapshots, "2025-04-01"),
    "2330.TW",
  );
  assert.equal(
    resolveQuantTickerFilter("6488.TWO", snapshots, "2025-04-01"),
    "6488.TWO",
  );
  assert.throws(
    () => resolveQuantTickerFilter("9999", snapshots, "2025-04-01"),
    /沒有官方日行情/,
  );

  const duplicateSymbolSnapshots = snapshots.map((snapshot) =>
    snapshot.exchange === "tpex"
      ? {
          ...snapshot,
          quotes: [
            ...snapshot.quotes,
            {
              ...snapshot.quotes[0],
              symbol: "2330",
              ticker: "2330.TWO",
            },
          ],
        }
      : snapshot,
  );
  assert.throws(
    () =>
      resolveQuantTickerFilter(
        "2330",
        duplicateSymbolSnapshots,
        "2025-04-01",
      ),
    /同時出現在上市與上櫃/,
  );
});

test("full-market backtest is deterministic and enters on the next trading day's open", () => {
  const snapshots = makeSnapshots();
  const evaluationStart =
    snapshots.find(
      (snapshot) => snapshot.exchange === "twse" && snapshot.date > "2025-04-01",
    )?.date ?? "2025-04-01";
  const input = {
    snapshots,
    requestedStartDate: evaluationStart,
    startingCapital: 1_000_000,
    topN: 1,
    rebalance: "monthly",
    factorWeights: {
      momentum20: 1,
      momentum60: 0,
      liquidity20: 0,
      lowVolatility20: 0,
    },
    entryRule: ALWAYS_ENTER,
    exitRule: NEVER_EXIT,
  };

  const first = calculateQuantBacktest(input);
  const second = calculateQuantBacktest(input);

  assert.deepEqual(first, second);
  assert.equal(first.eligibleSecurities, 3);
  assert.ok(first.tradingDays >= 20);
  assert.ok(first.metrics.tradeCount > 0);
  assert.ok(first.trades.length > 0);
  assert.equal(first.trades[0].side, "buy");
  assert.equal(first.trades[0].date, evaluationStart);
  assert.equal(first.trades[0].ticker, "2330.TW");
  assert.ok(first.trades[0].commission > 0);
  assert.ok(first.trades[0].slippageCost > 0);
  const stressed = calculateQuantBacktest({ ...input, costMultiplier: 2 });
  assert.ok(stressed.trades[0].price > first.trades[0].price);
  assert.ok(stressed.trades[0].slippageCost > first.trades[0].slippageCost);
  assert.ok(Number.isFinite(first.metrics.sharpeRatio));
  assert.ok(first.metrics.maxDrawdownPercent >= 0);
  assert.equal(first.equityCurve.at(-1).date, first.dataEndDate);
});

test("single-stock backtest excludes all other tickers", () => {
  const snapshots = makeSnapshots();
  const evaluationStart =
    snapshots.find(
      (snapshot) => snapshot.exchange === "twse" && snapshot.date > "2025-04-01",
    )?.date ?? "2025-04-01";
  const result = calculateQuantBacktest({
    snapshots,
    requestedStartDate: evaluationStart,
    startingCapital: 1_000_000,
    topN: 1,
    rebalance: "monthly",
    factorWeights: {
      momentum20: 0.4,
      momentum60: 0.3,
      liquidity20: 0.2,
      lowVolatility20: 0.1,
    },
    entryRule: ALWAYS_ENTER,
    exitRule: NEVER_EXIT,
    tickerFilter: "2330.TW",
  });

  assert.equal(result.eligibleSecurities, 1);
  assert.ok(result.trades.length > 0);
  assert.ok(result.trades.every((trade) => trade.ticker === "2330.TW"));
});

test("fixed-share sizing adds the requested number of shares on each eligible signal day", () => {
  const snapshots = makeSignalSnapshots();
  const result = calculateQuantBacktest({
    snapshots,
    requestedStartDate: snapshots[70].date,
    startingCapital: 100_000,
    topN: 1,
    rebalance: "daily",
    factorWeights: {
      momentum20: 0.4,
      momentum60: 0.3,
      liquidity20: 0.2,
      lowVolatility20: 0.1,
    },
    entryRule: ALWAYS_ENTER,
    exitRule: NEVER_EXIT,
    tickerFilter: "2330.TW",
    sharesPerEntry: 1,
  });

  assert.ok(result.trades.length >= 100);
  assert.ok(result.trades.every((trade) => trade.side === "buy" && trade.shares === 1));
});

test("recurring cash mode contributes on Wednesdays, buys whole shares, and ignores signal rules", () => {
  const snapshots = makeSignalSnapshots();
  const result = calculateQuantBacktest({
    snapshots,
    requestedStartDate: snapshots[70].date,
    startingCapital: 100_000,
    topN: 1,
    rebalance: "weekly",
    factorWeights: {
      momentum20: 0.4,
      momentum60: 0.3,
      liquidity20: 0.2,
      lowVolatility20: 0.1,
    },
    entryRule: {
      mode: "all",
      conditions: [{ factor: "momentum20", operator: "gte", threshold: 1_000_000 }],
    },
    exitRule: ALWAYS_ENTER,
    tickerFilter: "2330.TW",
    recurringContribution: { amount: 3_000, weekday: "wednesday" },
  });

  assert.ok(result.trades.length >= 10);
  assert.ok(result.trades.every((trade) => {
    assert.equal(trade.side, "buy");
    assert.ok(Number.isInteger(trade.shares) && trade.shares > 0);
    return new Date(`${trade.date}T00:00:00.000Z`).getUTCDay() === 3;
  }));
  assert.equal(result.metrics.contributedCapital, result.trades.length * 3_000);
  assert.ok(Math.abs(
    result.metrics.totalReturnPercent -
      ((result.metrics.finalEquity / result.metrics.contributedCapital - 1) * 100),
  ) < 1e-9);
});

test("recurring cash mode stops at the cumulative contribution cap and limits the final deposit", () => {
  const snapshots = makeSignalSnapshots();
  const result = calculateQuantBacktest({
    snapshots,
    requestedStartDate: snapshots[70].date,
    startingCapital: 100_000,
    topN: 1,
    rebalance: "weekly",
    factorWeights: {
      momentum20: 0.4,
      momentum60: 0.3,
      liquidity20: 0.2,
      lowVolatility20: 0.1,
    },
    entryRule: ALWAYS_ENTER,
    exitRule: NEVER_EXIT,
    tickerFilter: "2330.TW",
    recurringContribution: {
      amount: 3_000,
      weekday: "wednesday",
      totalContributionLimit: 10_000,
    },
  });

  assert.equal(result.metrics.contributedCapital, 10_000);
});

test("parses the explicit Chinese Wednesday and three-thousand-dollar contribution", () => {
  assert.deepEqual(
    parseRecurringContribution("每週三都買0050三千元"),
    { amount: 3_000, weekday: "wednesday" },
  );
  assert.equal(parseRecurringContribution("每月投入三千元"), null);
});

test("recurring cash mode rolls a Wednesday market holiday to the next session", () => {
  const snapshots = makeSignalSnapshots();
  const tuesdayStart = snapshots.find((snapshot, index) =>
    index >= 70 && new Date(`${snapshot.date}T00:00:00.000Z`).getUTCDay() === 2,
  );
  assert.ok(tuesdayStart);
  const wednesday = snapshots.find((snapshot) =>
    snapshot.date > tuesdayStart.date &&
    new Date(`${snapshot.date}T00:00:00.000Z`).getUTCDay() === 3,
  );
  assert.ok(wednesday);
  const withoutHoliday = snapshots.filter((snapshot) => snapshot.date !== wednesday.date);
  const result = calculateQuantBacktest({
    snapshots: withoutHoliday,
    requestedStartDate: tuesdayStart.date,
    startingCapital: 100_000,
    topN: 1,
    rebalance: "weekly",
    factorWeights: {
      momentum20: 0.4,
      momentum60: 0.3,
      liquidity20: 0.2,
      lowVolatility20: 0.1,
    },
    entryRule: ALWAYS_ENTER,
    exitRule: NEVER_EXIT,
    tickerFilter: "2330.TW",
    recurringContribution: { amount: 3_000, weekday: "wednesday" },
  });

  assert.equal(result.trades[0].date, snapshots.find((snapshot) =>
    snapshot.date > wednesday.date &&
    new Date(`${snapshot.date}T00:00:00.000Z`).getUTCDay() === 4,
  ).date);
});

test("AI entry and exit conditions control simulated buy and sell timing", () => {
  const snapshots = makeSignalSnapshots();
  const evaluationStart = snapshots[70].date;
  const result = calculateQuantBacktest({
    snapshots,
    requestedStartDate: evaluationStart,
    startingCapital: 1_000_000,
    topN: 1,
    rebalance: "weekly",
    factorWeights: {
      momentum20: 0.4,
      momentum60: 0.3,
      liquidity20: 0.2,
      lowVolatility20: 0.1,
    },
    entryRule: {
      mode: "all",
      conditions: [
        { factor: "momentum20", operator: "gte", threshold: 0.1 },
      ],
    },
    exitRule: {
      mode: "all",
      conditions: [
        { factor: "momentum20", operator: "lte", threshold: 0 },
      ],
    },
    tickerFilter: "2330.TW",
  });

  assert.deepEqual(
    result.trades.map((trade) => trade.side),
    ["buy", "sell"],
  );
  assert.equal(result.trades[0].ticker, "2330.TW");
  assert.equal(result.trades[1].ticker, "2330.TW");
  assert.ok(result.trades[1].date > result.trades[0].date);
  assert.equal(result.metrics.closedTradeCount, 1);
  assert.equal(result.metrics.winningTradeCount, 0);
  assert.equal(result.metrics.winRatePercent, 0);
  assert.ok(result.metrics.averageLossPercent < 0);
  assert.equal(result.metrics.payoffRatio, null);
});

test("daily single-stock backtests stop at the requested validation end date", () => {
  const snapshots = makeSignalSnapshots();
  const start = snapshots[70].date;
  const end = snapshots[110].date;
  const result = calculateQuantBacktest({
    snapshots,
    requestedStartDate: start,
    requestedEndDate: end,
    startingCapital: 1_000_000,
    topN: 1,
    rebalance: "daily",
    factorWeights: {
      momentum20: 1,
      momentum60: 0,
      liquidity20: 0,
      lowVolatility20: 0,
    },
    entryRule: ALWAYS_ENTER,
    exitRule: NEVER_EXIT,
    tickerFilter: "2330.TW",
  });
  assert.equal(result.equityCurve.at(-1).date, end);
  assert.equal(result.dataEndDate, end);
});
