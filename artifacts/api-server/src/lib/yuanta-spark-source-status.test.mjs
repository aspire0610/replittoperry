import assert from "node:assert/strict";
import test from "node:test";
import { describeYuantaSparkFailure } from "./yuanta-spark-source-status.ts";

test("describes safe, actionable fallback reasons", () => {
  assert.equal(describeYuantaSparkFailure("Yuanta SPARK relay 回應 HTTP 401"), "報價 HTTP 401");
  assert.equal(describeYuantaSparkFailure("Yuanta SPARK 期貨逐筆回應 HTTP 404"), "逐筆 HTTP 404");
  assert.equal(describeYuantaSparkFailure("fetch failed"), "SPARK 連線失敗");
  assert.equal(describeYuantaSparkFailure("The operation was aborted due to timeout"), "SPARK 查詢逾時");
});

test("never exposes arbitrary upstream response or connection details", () => {
  assert.equal(describeYuantaSparkFailure("https://private.example/token-secret"), "SPARK 回應無法使用");
  assert.equal(describeYuantaSparkFailure("Yuanta SPARK relay 回應 HTTP 401 private-secret"), "SPARK 回應無法使用");
});
