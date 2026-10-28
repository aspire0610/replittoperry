import assert from "node:assert/strict";
import test from "node:test";
import { splitAssistantAnswer } from "./assistant-chat-format.ts";

test("splits compact CEO market forecasts into readable evidence sections", () => {
  const sections = splitAssistantAnswer(
    "方向結論：偏漲。歷史回測：8/22，36.36%。近期行情消息：大盤收跌。反向訊號：指數低於20日均線。",
  );
  assert.deepEqual(sections, [
    { label: "方向結論", body: "偏漲。" },
    { label: "歷史回測", body: "8/22，36.36%。" },
    { label: "近期行情消息", body: "大盤收跌。" },
    { label: "反向訊號", body: "指數低於20日均線。" },
  ]);
});

test("preserves ordinary assistant prose and existing line breaks", () => {
  const content = "一般回答第一段。\n第二段。";
  assert.deepEqual(splitAssistantAnswer(content), [{ label: null, body: content }]);
});
