import assert from "node:assert/strict";
import test from "node:test";
import { parseTwseMiIndexDailyClose } from "./official-twse-mi-index.ts";

const fields = [
  "證券代號",
  "證券名稱",
  "成交股數",
  "成交金額",
  "收盤價",
  "漲跌(+/-)",
  "漲跌價差",
];

function payload({
  date = "20261013",
  stat = "OK",
  rows = [],
  tableFields = fields,
} = {}) {
  return {
    stat,
    date,
    tables: [
      {
        title: "115年10月13日 每日收盤行情(全部)",
        fields: tableFields,
        data: rows,
      },
    ],
  };
}

function completeRows() {
  return Array.from({ length: 1_000 }, (_, index) => [
    String(1000 + index),
    `股票${index}`,
    "1,234",
    "56,789",
    "42.50",
    "<p style= color:red>+</p>",
    "0.50",
  ]);
}

test("maps complete official MI_INDEX rows and signed price changes", () => {
  const rows = completeRows();
  rows[0] = [
    "2330",
    "台積電",
    "40,796,261",
    "101,920,437,251",
    "2,490.00",
    "<p style= color:green>-</p>",
    "50.00",
  ];
  rows[1] = [
    "0055",
    "元大MSCI金融",
    "923,983",
    "46,687,860",
    "50.75",
    "<p style= color:red>+</p>",
    "0.65",
  ];
  rows[2] = ["0056", "元大高股息", "1,000", "20,000", "20.00", "<p> </p>", "0.00"];

  const parsed = parseTwseMiIndexDailyClose(payload({ rows }), "2026-10-13");
  assert.equal(parsed.length, 1_000);
  assert.deepEqual(parsed.slice(0, 3).map((row) => row.Change), ["-50.00", "0.65", "0"]);
  assert.equal(parsed[0].Date, "1151013");
  assert.equal(parsed[0].Code, "2330");
  assert.equal(parsed[0].ClosingPrice, "2,490.00");
  assert.equal(parsed[0].TradeVolume, "40,796,261");
  assert.equal(parsed[0].TradeValue, "101,920,437,251");
});

test("rejects a response from a different exchange date", () => {
  assert.throws(
    () => parseTwseMiIndexDailyClose(payload({ rows: completeRows() }), "2026-10-14"),
    /狀態或日期無法驗證/,
  );
});

test("rejects unsuccessful or incomplete MI_INDEX reports", () => {
  assert.throws(
    () => parseTwseMiIndexDailyClose(payload({ stat: "沒有符合條件", rows: completeRows() }), "2026-10-13"),
    /狀態或日期無法驗證/,
  );
  assert.throws(
    () => parseTwseMiIndexDailyClose(payload({ rows: completeRows().slice(0, 999) }), "2026-10-13"),
    /筆數不足/,
  );
  assert.throws(
    () =>
      parseTwseMiIndexDailyClose(
        payload({
          rows: completeRows().map((row) => [...row.slice(0, 4), "--", ...row.slice(5)]),
        }),
        "2026-10-13",
      ),
    /有效收盤行情筆數不足/,
  );
  assert.throws(
    () =>
      parseTwseMiIndexDailyClose(
        payload({ rows: completeRows(), tableFields: fields.slice(1) }),
        "2026-10-13",
      ),
    /欄位不完整/,
  );
});
