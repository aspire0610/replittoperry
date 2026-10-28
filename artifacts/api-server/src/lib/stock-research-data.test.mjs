import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getInvestmentTrustBuyStreak,
  getOfficialHolderMarginScore,
  getStockInstitutionalData,
} from "./stock-research-data.ts";

const jsonResponse = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { "content-type": "application/json" },
});

test("TPEx holder-margin score uses the latest matching official date", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("mopsfin_t187ap02_O")) {
      return jsonResponse([{ SecuritiesCompanyCode: "6488", Date: "1151015" }]);
    }
    if (url.includes("tpex_mainboard_margin_balance")) {
      return jsonResponse([{
        SecuritiesCompanyCode: "6488",
        Date: "1151015",
        MarginPurchaseBalancePreviousDay: "100",
        MarginPurchaseBalance: "90",
        ShortSaleBalancePreviousDay: "10",
        ShortSaleBalance: "8",
      }]);
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const result = await getOfficialHolderMarginScore("6488", ["2026-10-14", "2026-10-15"], "TWO");
    assert.equal(result.points, 10);
    assert.match(result.note, /逾 10% 大股東名單有列示/);
    const stale = await getOfficialHolderMarginScore("6488", ["2026-10-15", "2026-10-16"], "TWO");
    assert.equal(stale.points, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TPEx investment-trust streak counts consecutive positive sessions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith("3itrade_hedge_result.php")) throw new Error(`Unexpected URL: ${url}`);
    const date = url.searchParams.get("d");
    const row = Array(24).fill("0");
    row[0] = "6488";
    row[13] = "120";
    return jsonResponse({ tables: [{ date, data: [row] }] });
  };
  try {
    const result = await getInvestmentTrustBuyStreak("6488.TWO", undefined, {
      includeToday: true,
      maxCalendarDays: 1,
    });
    assert.equal(result.count, 2);
    assert.equal(result.observedDates.length, 2);
    assert.equal(result.source, "TPEx 三大法人日交易資訊");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TWSE holder-margin score rejects mismatched official report dates", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("t187ap02_L")) return jsonResponse([]);
    if (url.includes("date=20261015")) return jsonResponse({
      date: "20261014",
      tables: [{ title: "融資融券彙總 (全部)", data: [["2330", "", "", "", "", "", "100", "", "", "", "", "", "10"]] }],
    });
    if (url.includes("date=20261014")) return jsonResponse({
      date: "20261014",
      tables: [{ title: "融資融券彙總 (全部)", data: [["2330", "", "", "", "", "", "110", "", "", "", "", "", "12"]] }],
    });
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const result = await getOfficialHolderMarginScore("2330", ["2026-10-14", "2026-10-15"], "TW");
    assert.equal(result.points, null);
    assert.match(result.note, /日期與最新完整日線不一致/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("institutional data retries the exact market date with FinMind when official lookups miss", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FINMIND_API_TOKEN;
  process.env.FINMIND_API_TOKEN = "test-token";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.finmindtrade.com") {
      assert.equal(url.searchParams.get("dataset"), "TaiwanStockInstitutionalInvestorsBuySell");
      assert.equal(url.searchParams.get("data_id"), "2330");
      assert.equal(url.searchParams.get("start_date"), "2026-10-16");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-token");
      return jsonResponse({
        status: 200,
        data: [
          { date: "2026-10-16", name: "Foreign_Investor", buy: 1_000, sell: 300 },
          { date: "2026-10-16", name: "Foreign_Dealer_Self", buy: 100, sell: 50 },
          { date: "2026-10-16", name: "Investment_Trust", buy: 200, sell: 80 },
        ],
      });
    }
    throw new Error(`Official lookup unavailable: ${url}`);
  };
  try {
    const result = await getStockInstitutionalData("2330.TW", undefined, "2026-10-16");
    assert.equal(result.status, "available");
    assert.equal(result.observedAt, "2026-10-16");
    assert.equal(result.foreignNetShares, 750);
    assert.equal(result.investmentTrustNetShares, 120);
    assert.match(result.source ?? "", /FinMind.*備援/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FINMIND_API_TOKEN;
    else process.env.FINMIND_API_TOKEN = originalToken;
  }
});
