import assert from "node:assert/strict";
import test from "node:test";
import { formatLineAssistantReply } from "./line-assistant-format.ts";

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
