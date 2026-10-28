import assert from "node:assert/strict";
import test from "node:test";
import { parseEtfNavDisclosure } from "./etf-nav-disclosure.ts";

test("parses issuer NAV disclosures and calculates discount/premium", () => {
  const data = parseEtfNavDisclosure({
    a1: [
      {
        msgArray: [
          {
            a: "00686R",
            e: "0.97",
            f: "0.98",
            i: "20261023",
            j: "17:00:51",
          },
        ],
      },
    ],
  });

  assert.deepEqual(data.get("00686R"), {
    marketPrice: 0.97,
    netAssetValue: 0.98,
    discountPremiumAmount: -0.010000000000000009,
    discountPremiumPercent: (-0.010000000000000009 / 0.98) * 100,
    updatedAt: "2026-10-23T17:00:51+08:00",
  });
});

test("keeps the newest valid disclosure for duplicate ETF symbols", () => {
  const data = parseEtfNavDisclosure({
    a1: [
      {
        msgArray: [
          { a: "0056", e: 56.1, f: 56.2, i: "20261022", j: "17:00:00" },
          { a: "0056", e: 56.3, f: 56.16, i: "20261023", j: "13:30:45" },
        ],
      },
    ],
  });

  assert.equal(data.get("0056")?.marketPrice, 56.3);
  assert.equal(data.get("0056")?.netAssetValue, 56.16);
});

test("ignores malformed rows and rejects invalid NAV values", () => {
  const data = parseEtfNavDisclosure({
    a1: [
      {
        msgArray: [
          { a: "0056", e: 56.3, f: 0, i: "20261023", j: "13:30:45" },
          { a: "0057", e: "—", f: "bad", i: "20260230", j: "25:00:00" },
          { a: "STOCK", e: 10, f: 10, i: "20261023", j: "13:30:45" },
        ],
      },
    ],
  });

  assert.equal(data.get("0056")?.netAssetValue, null);
  assert.equal(data.get("0056")?.discountPremiumPercent, null);
  assert.equal(data.get("0057")?.updatedAt, null);
  assert.equal(data.has("STOCK"), false);
});
