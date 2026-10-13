import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseDuckDuckGoAvailability } from "./duckduckgo-search.ts";

const originalFetch = globalThis.fetch;
const resultPage = `
  <div class="result results_links">
    <a class="result__a" href="https://example.com/story">Fixture title</a>
    <a class="result__snippet" href="https://example.com/story">Fixture snippet</a>
  </div>
`;

test("diagnostic reports status and count only for a successful fixed-query check", async () => {
  let requestedUrl;
  globalThis.fetch = async (input) => {
    requestedUrl = new URL(String(input));
    return new Response(resultPage, { status: 200 });
  };

  try {
    const result = await diagnoseDuckDuckGoAvailability();
    assert.equal(requestedUrl.searchParams.get("q"), "Taiwan stock market news");
    assert.deepEqual(Object.keys(result).sort(), [
      "checkedAt",
      "failureKind",
      "httpStatus",
      "outcome",
      "provider",
      "resultCount",
    ]);
    assert.equal(result.provider, "duckduckgo");
    assert.equal(result.outcome, "searched");
    assert.equal(result.resultCount, 1);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.failureKind, null);
    assert.equal(result.checkedAt, new Date(result.checkedAt).toISOString());
    assert.equal(JSON.stringify(result).includes("Fixture"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("diagnostic distinguishes an empty result page from a provider failure", async () => {
  globalThis.fetch = async () => new Response("<html><body>no result markup</body></html>", { status: 200 });
  try {
    const result = await diagnoseDuckDuckGoAvailability();
    assert.equal(result.outcome, "empty");
    assert.equal(result.resultCount, 0);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.failureKind, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("diagnostic reports an HTTP failure without leaking the response body", async () => {
  globalThis.fetch = async () => new Response("provider response text", { status: 503 });
  try {
    const result = await diagnoseDuckDuckGoAvailability();
    assert.equal(result.outcome, "failed");
    assert.equal(result.resultCount, 0);
    assert.equal(result.failureKind, "http_error");
    assert.equal(result.httpStatus, 503);
    assert.equal(JSON.stringify(result).includes("provider response text"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("diagnostic maps timeout and network exceptions to safe failure categories", async () => {
  globalThis.fetch = async () => {
    const error = new Error("private transport detail");
    error.name = "TimeoutError";
    throw error;
  };
  try {
    const timeout = await diagnoseDuckDuckGoAvailability();
    assert.equal(timeout.failureKind, "timeout");
    assert.equal(timeout.httpStatus, null);
    assert.equal(JSON.stringify(timeout).includes("private transport detail"), false);

    globalThis.fetch = async () => {
      throw new Error("private transport detail");
    };
    const networkError = await diagnoseDuckDuckGoAvailability();
    assert.equal(networkError.failureKind, "network_error");
    assert.equal(networkError.httpStatus, null);
    assert.equal(JSON.stringify(networkError).includes("private transport detail"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
