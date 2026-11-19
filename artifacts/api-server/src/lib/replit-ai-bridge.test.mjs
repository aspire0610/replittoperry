import assert from "node:assert/strict";
import test from "node:test";
import {
  isReplitAiBridgeConfigured,
  requestReplitAiCompletion,
} from "./replit-ai-bridge.ts";

const originalUrl = process.env.REPLIT_AI_BRIDGE_URL;
const originalToken = process.env.REPLIT_AI_BRIDGE_TOKEN;
const originalFetch = globalThis.fetch;

test("reports bridge configuration only when URL and token are present", () => {
  process.env.REPLIT_AI_BRIDGE_URL = "https://bridge.example/api/market/replit-ai-summary";
  delete process.env.REPLIT_AI_BRIDGE_TOKEN;
  assert.equal(isReplitAiBridgeConfigured(), false);
  process.env.REPLIT_AI_BRIDGE_TOKEN = "test-token";
  assert.equal(isReplitAiBridgeConfigured(), true);
});

test("sends structured completions over HTTPS and returns validated output text", async () => {
  process.env.REPLIT_AI_BRIDGE_URL = "https://bridge.example/api/market/replit-ai-summary";
  process.env.REPLIT_AI_BRIDGE_TOKEN = "test-token";
  let calledUrl;
  let calledInit;
  globalThis.fetch = async (url, init) => {
    calledUrl = String(url);
    calledInit = init;
    return new Response(JSON.stringify({ output: '{"answer":"測試回答"}', aiProvider: "openai" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const output = await requestReplitAiCompletion(
      '{"userQuestion":"測試"}',
      "CEO instructions",
      "line_ceo_answer",
      { type: "object", properties: { answer: { type: "string" } } },
    );
    assert.equal(output, '{"answer":"測試回答"}');
    assert.equal(calledUrl, "https://bridge.example/api/market/replit-ai-completion");
    assert.equal(calledInit.method, "POST");
    assert.equal(calledInit.headers.Authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(calledInit.body), {
      input: '{"userQuestion":"測試"}',
      instructions: "CEO instructions",
      schemaName: "line_ceo_answer",
      schema: { type: "object", properties: { answer: { type: "string" } } },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-HTTPS and unexpected bridge paths without making a request", async () => {
  process.env.REPLIT_AI_BRIDGE_TOKEN = "test-token";
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("Unexpected request");
  };
  try {
    process.env.REPLIT_AI_BRIDGE_URL = "http://bridge.example/api/market/replit-ai-summary";
    await assert.rejects(
      requestReplitAiCompletion("{}", "instructions", "test_schema", {}),
      /must use HTTPS/u,
    );
    process.env.REPLIT_AI_BRIDGE_URL = "https://bridge.example/unexpected";
    await assert.rejects(
      requestReplitAiCompletion("{}", "instructions", "test_schema", {}),
      /unexpected path/u,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(() => {
  if (originalUrl === undefined) delete process.env.REPLIT_AI_BRIDGE_URL;
  else process.env.REPLIT_AI_BRIDGE_URL = originalUrl;
  if (originalToken === undefined) delete process.env.REPLIT_AI_BRIDGE_TOKEN;
  else process.env.REPLIT_AI_BRIDGE_TOKEN = originalToken;
});
