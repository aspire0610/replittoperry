import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLineAssistantReply,
  getLineDailySummaryMode,
} from "./line-assistant-format.ts";

test("routes LINE daily summary commands to the shared premarket and closing summaries", () => {
  assert.equal(getLineDailySummaryMode("盤後摘要"), "closing");
  assert.equal(getLineDailySummaryMode("請給我今天台股盤後總結"), "closing");
  assert.equal(getLineDailySummaryMode("再提供今日盤前摘要"), "premarket");
  assert.equal(getLineDailySummaryMode("6223 為什麼一直跌"), null);
  assert.equal(getLineDailySummaryMode("一般台股盤勢怎麼看"), null);
});

test("formats long LINE source URLs as compact clickable titles", () => {
  const longUrl = `https://news.google.com/rss/articles/${"CBMi".repeat(80)}`;
  const message = formatLineAssistantReply({
    answer: "6223 旺矽盤後下跌。",
    sources: [
      { title: "旺矽今日行情與市場消息".repeat(8), url: longUrl },
      { title: "不安全連結", url: "javascript:alert(1)" },
    ],
    searchStatus: "searched",
    aiProvider: "test",
    answeredAt: new Date("2026-10-13T05:30:00Z"),
  });

  assert.equal(message.type, "flex");
  if (message.type !== "flex") return;

  const textComponents = message.contents.body.contents.filter(
    (component) => component.type === "text",
  );
  const sourceLink = textComponents.find((component) => component.action);
  assert.ok(sourceLink);
  assert.equal(sourceLink.action.uri, longUrl);
  assert.ok(sourceLink.text.length <= 67);
  assert.equal(
    textComponents.some((component) => component.text?.includes(longUrl)),
    false,
  );
  assert.match(message.altText, /參考來源/u);
});

test("keeps replies without valid sources as regular LINE text messages", () => {
  const message = formatLineAssistantReply({
    answer: "目前沒有可驗證的行情。",
    sources: [{ title: "不安全連結", url: "javascript:alert(1)" }],
    searchStatus: "not_needed",
    aiProvider: "test",
    answeredAt: new Date("2026-10-13T05:30:00Z"),
  });

  assert.deepEqual(message, {
    type: "text",
    text: "目前沒有可驗證的行情。",
  });
});

test("formats all LINE answers with readable spacing and hides long inline URLs", () => {
  const message = formatLineAssistantReply({
    answer: "結論：目前不建議買。原因：方案未通過驗證。\n\n來源：https://news.google.com/rss/articles/very-long-token",
    sources: [{ title: "市場消息來源", url: "https://news.google.com/rss/articles/very-long-token" }],
    searchStatus: "searched",
    aiProvider: "test",
    answeredAt: new Date("2026-10-13T05:30:00Z"),
  });
  assert.equal(message.type, "flex");
  if (message.type !== "flex") return;
  const visibleText = message.contents.body.contents
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.match(visibleText, /結論：目前不建議買。\n原因：方案未通過驗證/u);
  assert.match(visibleText, /連結見下方參考來源/u);
  assert.equal(visibleText.includes("very-long-token"), false);

  const plain = formatLineAssistantReply({
    answer: "答案第一句。\n\n\n操作方向：先不買。",
    sources: [],
    searchStatus: "not_needed",
    aiProvider: "test",
    answeredAt: new Date("2026-10-13T05:30:00Z"),
  });
  assert.equal(plain.type, "text");
  if (plain.type === "text") assert.equal(plain.text, "答案第一句。\n\n操作方向：先不買。");

  const inlineOnly = formatLineAssistantReply({
    answer: "參考：https://example.com/markets/latest",
    sources: [],
    searchStatus: "searched",
    aiProvider: "test",
    answeredAt: new Date("2026-10-13T05:30:00Z"),
  });
  assert.equal(inlineOnly.type, "flex");
  if (inlineOnly.type === "flex") {
    const links = inlineOnly.contents.body.contents.filter((item) => item.action);
    assert.equal(links.length, 1);
    assert.equal(links[0].action.uri, "https://example.com/markets/latest");
    assert.equal(links[0].text.includes("example.com"), true);
  }
});
