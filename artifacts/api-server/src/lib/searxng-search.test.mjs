import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnoseSearxngAvailability,
  parseSearxngSearchResponse,
  searchSearxng,
} from "./searxng-search.ts";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.SEARXNG_BASE_URL;
const originalAuthUsername = process.env.SEARXNG_AUTH_USERNAME;
const originalAuthPassword = process.env.SEARXNG_AUTH_PASSWORD;
const resultPayload = {
  results: [
    {
      title: "Taiwan market update",
      url: "https://example.org/market",
      content: "A fixture snippet for the market update.",
    },
    {
      title: "HTTP result is rejected",
      url: "http://example.org/insecure",
      content: "Must not become a source.",
    },
    {
      title: "Credentials are rejected",
      url: "https://name:secret@example.org/private",
      content: "Must not become a source either.",
    },
    {
      title: "Duplicate result",
      url: "https://example.org/market",
      content: "A duplicate link.",
    },
  ],
};

function restoreEnvironment() {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.SEARXNG_BASE_URL;
  else process.env.SEARXNG_BASE_URL = originalBaseUrl;
  if (originalAuthUsername === undefined) delete process.env.SEARXNG_AUTH_USERNAME;
  else process.env.SEARXNG_AUTH_USERNAME = originalAuthUsername;
  if (originalAuthPassword === undefined) delete process.env.SEARXNG_AUTH_PASSWORD;
  else process.env.SEARXNG_AUTH_PASSWORD = originalAuthPassword;
}

test("maps unique secure SearXNG results into title, URL, and snippet", () => {
  assert.deepEqual(parseSearxngSearchResponse(resultPayload), [{
    title: "Taiwan market update",
    url: "https://example.org/market",
    snippet: "A fixture snippet for the market update.",
  }]);
  assert.deepEqual(parseSearxngSearchResponse({ results: null }), []);
});

test("uses the fixed admin query and returns metadata without query or result content", async () => {
  process.env.SEARXNG_BASE_URL = "https://search.example.org/searx/";
  process.env.SEARXNG_AUTH_USERNAME = "api-user";
  process.env.SEARXNG_AUTH_PASSWORD = "private-test-password";
  let requestedUrl;
  let requestedAuthorization;
  globalThis.fetch = async (input, init) => {
    requestedUrl = new URL(String(input));
    requestedAuthorization = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify(resultPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const diagnostic = await diagnoseSearxngAvailability();
    assert.equal(requestedUrl.origin, "https://search.example.org");
    assert.equal(requestedUrl.pathname, "/searx/search");
    assert.equal(requestedUrl.searchParams.get("q"), "Taiwan stock market news");
    assert.equal(requestedUrl.searchParams.get("format"), "json");
    assert.equal(
      requestedAuthorization,
      `Basic ${Buffer.from("api-user:private-test-password").toString("base64")}`,
    );
    assert.deepEqual({
      provider: diagnostic.provider,
      outcome: diagnostic.outcome,
      resultCount: diagnostic.resultCount,
      failureKind: diagnostic.failureKind,
      httpStatus: diagnostic.httpStatus,
    }, {
      provider: "searxng",
      outcome: "searched",
      resultCount: 1,
      failureKind: null,
      httpStatus: 200,
    });
    assert.equal(JSON.stringify(diagnostic).includes("Taiwan stock market"), false);
    assert.equal(JSON.stringify(diagnostic).includes("fixture snippet"), false);
    assert.equal(JSON.stringify(diagnostic).includes("private-test-password"), false);
  } finally {
    restoreEnvironment();
  }
});

test("fails closed for missing or unsafe instance URLs without making a request", async () => {
  delete process.env.SEARXNG_AUTH_USERNAME;
  delete process.env.SEARXNG_AUTH_PASSWORD;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Unexpected network request");
  };
  try {
    for (const baseUrl of [undefined, "http://search.example.org", "https://user:pass@search.example.org"]) {
      if (baseUrl === undefined) delete process.env.SEARXNG_BASE_URL;
      else process.env.SEARXNG_BASE_URL = baseUrl;
      const diagnostic = await diagnoseSearxngAvailability();
      assert.equal(diagnostic.failureKind, "configuration_error");
      assert.equal(diagnostic.httpStatus, null);
    }
    assert.equal(fetchCalls, 0);
  } finally {
    restoreEnvironment();
  }
});

test("fails closed when only one Basic Auth credential is configured", async () => {
  process.env.SEARXNG_BASE_URL = "https://search.example.org";
  process.env.SEARXNG_AUTH_USERNAME = "api-user";
  delete process.env.SEARXNG_AUTH_PASSWORD;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Unexpected network request");
  };
  try {
    const diagnostic = await diagnoseSearxngAvailability();
    assert.equal(diagnostic.failureKind, "configuration_error");
    assert.equal(diagnostic.httpStatus, null);
    assert.equal(fetchCalls, 0);
  } finally {
    restoreEnvironment();
  }
});

test("does not expose provider error response bodies", async () => {
  process.env.SEARXNG_BASE_URL = "https://search.example.org";
  globalThis.fetch = async () => new Response("private provider detail", { status: 429 });
  try {
    const diagnostic = await diagnoseSearxngAvailability();
    assert.equal(diagnostic.failureKind, "http_error");
    assert.equal(diagnostic.httpStatus, 429);
    assert.equal(JSON.stringify(diagnostic).includes("private provider detail"), false);
  } finally {
    restoreEnvironment();
  }
});

test("searches through the configured instance without requiring a provider API key", async () => {
  process.env.SEARXNG_BASE_URL = "https://search.example.org";
  delete process.env.SEARXNG_AUTH_USERNAME;
  delete process.env.SEARXNG_AUTH_PASSWORD;
  let requestedUrl;
  let requestedAuthorization;
  globalThis.fetch = async (input, init) => {
    requestedUrl = new URL(String(input));
    requestedAuthorization = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify(resultPayload), { status: 200 });
  };
  try {
    const results = await searchSearxng("local fixture");
    assert.equal(requestedUrl.searchParams.get("q"), "local fixture");
    assert.equal(requestedAuthorization, null);
    assert.deepEqual(results, [{
      title: "Taiwan market update",
      url: "https://example.org/market",
      snippet: "A fixture snippet for the market update.",
    }]);
  } finally {
    restoreEnvironment();
  }
});

test("uses configured Basic Auth for regular search requests", async () => {
  process.env.SEARXNG_BASE_URL = "https://search.example.org";
  process.env.SEARXNG_AUTH_USERNAME = "api-user";
  process.env.SEARXNG_AUTH_PASSWORD = "private-test-password";
  let requestedAuthorization;
  globalThis.fetch = async (_input, init) => {
    requestedAuthorization = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify(resultPayload), { status: 200 });
  };
  try {
    await searchSearxng("private fixture");
    assert.equal(
      requestedAuthorization,
      `Basic ${Buffer.from("api-user:private-test-password").toString("base64")}`,
    );
  } finally {
    restoreEnvironment();
  }
});
