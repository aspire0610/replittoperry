import assert from "node:assert/strict";
import test from "node:test";
import { AiProviderFallbackError } from "./ai-provider-fallback.ts";
import { getAiProviderFailure } from "./ai-provider-error.ts";

test("preserves AI provider rate-limit messages and status", () => {
  const error = new AiProviderFallbackError("AI 服務目前忙碌，請稍後再試。", 429);

  assert.deepEqual(getAiProviderFailure(error), {
    status: 429,
    message: "AI 服務目前忙碌，請稍後再試。",
  });
});

test("preserves AI provider timeout messages and status", () => {
  const error = new AiProviderFallbackError("AI 分析逾時，請稍後重試。", 504);

  assert.deepEqual(getAiProviderFailure(error), {
    status: 504,
    message: "AI 分析逾時，請稍後重試。",
  });
});

test("does not expose messages from unrelated errors", () => {
  assert.equal(getAiProviderFailure(new Error("internal")), null);
});
