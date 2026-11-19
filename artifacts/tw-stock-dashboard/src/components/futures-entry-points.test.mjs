import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  root: new URL("../..", import.meta.url).pathname,
  server: { middlewareMode: true, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
  esbuild: { jsx: "automatic" },
});
let FuturesEntryPoints;
try {
  ({ FuturesEntryPoints } = await server.ssrLoadModule("/src/components/futures-entry-points.tsx"));
} finally { await server.close(); }
const render = (props) => renderToStaticMarkup(React.createElement(FuturesEntryPoints, props));
const start = Date.parse("2026-11-06T08:45:00+08:00");
const now = start + 110 * 60_000;
const data = {
  status: "live", symbol: "TXF1", date: "20261106", price: 105,
  asOf: new Date(now).toISOString(),
  source: "Verified source：價格：Yuanta SPARK · TXF1；分 K：Yuanta SPARK · TXF1",
  bars: Array.from({ length: 110 }, (_, i) => ({
    time: new Date(start + i * 60_000).toISOString(),
    ...i < 100 ? { open: 105, high: 110, low: 100, close: 105 }
      : i < 105 ? { open: 101, high: 103, low: 100, close: 102 }
      : { open: 102, high: 104, low: 101, close: 104 },
  })),
};

test("entry UI renders all scenarios, actual prices and the source disclosures", () => {
  const original = Date.now;
  Date.now = () => now;
  try {
    const html = render({ data });
    for (const id of ["support_bounce", "key_reclaim", "resistance_reject", "key_breakdown"]) {
      assert.ok(html.includes(`card-futures-entry-${id}`));
    }
    assert.match(html, /st-ready/);
    assert.match(html, /已觸及・待收K/);
    assert.match(html, /Verified source/);
    assert.match(html, /停損/);
    assert.match(html, /示意目標 3R/);
    assert.match(html, /非日 ATR/);
    assert.match(html, /停損風險上限（1× SPARK 5 分 ATR14）/);
    assert.doesNotMatch(html, /TAIFEX|日 ATR14/);
    assert.match(html, /非 WinSmart 成本線/);
    assert.match(html, /110 分鐘/);
    assert.match(html, /未計手續費與滑價/);
    assert.match(html, /target="_blank"/);
  } finally { Date.now = original; }
});
test("failed request, closed session and stale clock render no actionable cards", () => {
  const original = Date.now;
  Date.now = () => now;
  try {
    const missing = render({ data: undefined });
    assert.match(missing, /讀取中/);
    assert.doesNotMatch(missing, /card-futures-entry-/);
    const failed = render({ data, requestFailed: true });
    assert.match(failed, /請求失敗/);
    assert.doesNotMatch(failed, /card-futures-entry-|st-ready/);
    const closed = render({ data: { ...data, status: "closed" } });
    assert.match(closed, /休市／待開盤/);
    assert.doesNotMatch(closed, /card-futures-entry-|st-ready/);
    Date.now = () => now + 181_000;
    const stale = render({ data });
    assert.match(stale, /資料過期/);
    assert.doesNotMatch(stale, /card-futures-entry-|st-ready/);
  } finally { Date.now = original; }
});
