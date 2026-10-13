import assert from "node:assert/strict";
import test from "node:test";
import { streamQuantResearch } from "./quant-research-stream.ts";

const originalFetch = globalThis.fetch;
const input = {
  hypothesis: "測試動能因子是否優於大盤",
  rangeMonths: 6,
  startingCapital: 1_000_000,
  topN: 10,
  rebalance: "monthly",
};

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function eventStreamResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("reads progress and result events split across stream chunks", async () => {
  const progress = {
    type: "progress",
    stage: "market-data",
    message: "TWSE 2026-01-19：正在讀取官方行情。",
    current: 3,
    total: 20,
  };
  const result = { runId: 42 };
  const proxyPadding = `:${" ".repeat(4_096)}\n\n`;
  const frames = [
    `data: ${JSON.stringify(progress)}\n\n${proxyPadding}`,
    `data: ${JSON.stringify({ type: "result", result })}\n\n${proxyPadding}`,
  ].join("");
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/account/quant-research/stream");
    assert.equal(options.method, "POST");
    assert.equal(options.credentials, "include");
    assert.deepEqual(JSON.parse(options.body), input);
    return eventStreamResponse(
      [...frames].map((_, index) =>
        index % 7 === 0 ? frames.slice(index, index + 7) : "",
      ).filter(Boolean),
    );
  };

  const receivedProgress = [];
  const actual = await streamQuantResearch(input, (event) =>
    receivedProgress.push(event),
  );

  assert.deepEqual(actual, result);
  assert.deepEqual(receivedProgress, [progress]);
});

test("surfaces server-sent errors instead of replacing them with a generic message", async () => {
  const message =
    "TWSE 2026-01-19 官方日行情端點回傳 HTTP 307，但未提供重新導向位置。";
  globalThis.fetch = async () =>
    eventStreamResponse([
      `data: ${JSON.stringify({ type: "error", message })}\n\n`,
    ]);

  await assert.rejects(
    streamQuantResearch(input, () => {}),
    new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("shows validation and rate-limit messages returned before the stream starts", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "研究請求過於頻繁，請稍後再試。" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });

  await assert.rejects(
    streamQuantResearch(input, () => {}),
    /研究請求過於頻繁，請稍後再試/,
  );
});
