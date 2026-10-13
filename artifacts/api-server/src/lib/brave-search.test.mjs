import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnoseBraveAvailability,
  parseBraveSearchResponse,
  searchBrave,
} from "./brave-search.ts";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.BRAVE_SEARCH_API_KEY;
const resultsPayload = {
  web: {
    results: [
      {
        title: "Market update",
        url: "https://example.com/market",
        description: "A short market summary.",
      },
      {
        title: "Unsafe URL",
        url: "http://example.com/insecure",
        description: "This result should be rejected.",
      },
      {
        title: "Credential URL",
        url: "https://user:pass@example.com/private",
        description: "This result should also be rejected.",
      },
      {
        title: "Duplicate",
        url: "https://example.com/market",
        description: "Duplicate URLs are removed.",
      },
    ],
  },
};

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
}

test("maps only unique HTTPS Brave web results into safe source fields", () => {
  assert.deepEqual(parseBraveSearchResponse(resultsPayload), [{
    title: "Market update",
    url: "https://example.com/market",
    snippet: "A short market summary.",
  }]);
  assert.deepEqual(parseBraveSearchResponse({ web: { results: "invalid" } }), []);
});

test("uses the fixed diagnostic query and reports metadata only", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
  let requestedUrl;
  let receivedHeader;
  globalThis.fetch = async (input, options) => {
    requestedUrl = new URL(String(input));
    receivedHeader = new Headers(options?.headers).get("X-Subscription-Token");
    return new Response(JSON.stringify(resultsPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const diagnostic = await diagnoseBraveAvailability();
    assert.equal(requestedUrl.origin, "https://api.search.brave.com");
    assert.equal(requestedUrl.pathname, "/res/v1/web/search");
    assert.equal(requestedUrl.searchParams.get("q"), "Taiwan stock market news");
    assert.equal(requestedUrl.searchParams.get("count"), "5");
    assert.equal(receivedHeader, "test-brave-key");
    assert.deepEqual({
      provider: diagnostic.provider,
      outcome: diagnostic.outcome,
      resultCount: diagnostic.resultCount,
      failureKind: diagnostic.failureKind,
      httpStatus: diagnostic.httpStatus,
    }, {
      provider: "brave",
      outcome: "searched",
      resultCount: 1,
      failureKind: null,
      httpStatus: 200,
    });
    assert.equal(JSON.stringify(diagnostic).includes("Market update"), false);
    assert.equal(JSON.stringify(diagnostic).includes("Taiwan stock"), false);
  } finally {
    restoreEnvironment();
  }
});

test("fails closed when the provider key is missing and does not make a request", async () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Unexpected network request");
  };
  try {
    const diagnostic = await diagnoseBraveAvailability();
    assert.equal(diagnostic.provider, "brave");
    assert.equal(diagnostic.outcome, "failed");
    assert.equal(diagnostic.resultCount, 0);
    assert.equal(diagnostic.failureKind, "configuration_error");
    assert.equal(diagnostic.httpStatus, null);
    assert.equal(fetchCalls, 0);
  } finally {
    restoreEnvironment();
  }
});

test("returns only the HTTP status for provider errors, not the response body", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
  globalThis.fetch = async () => new Response("provider body must not escape", { status: 403 });
  try {
    const result = await diagnoseBraveAvailability();
    assert.equal(result.outcome, "failed");
    assert.equal(result.failureKind, "http_error");
    assert.equal(result.httpStatus, 403);
    assert.equal(JSON.stringify(result).includes("provider body"), false);
  } finally {
    restoreEnvironment();
  }
});

test("maps normal search results without exposing the raw provider payload", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
  globalThis.fetch = async () => new Response(JSON.stringify(resultsPayload), { status: 200 });
  try {
    assert.deepEqual(await searchBrave("test query"), [{
      title: "Market update",
      url: "https://example.com/market",
      snippet: "A short market summary.",
    }]);
  } finally {
    restoreEnvironment();
  }
});
