import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnoseLineWebSearch,
  getLineWebSearchProvider,
  searchLineWeb,
} from "./line-web-search.ts";

const originalProvider = process.env.LINE_WEB_SEARCH_PROVIDER;
const originalApiKey = process.env.BRAVE_SEARCH_API_KEY;
const originalSearxngBaseUrl = process.env.SEARXNG_BASE_URL;
const originalSearxngAuthUsername = process.env.SEARXNG_AUTH_USERNAME;
const originalSearxngAuthPassword = process.env.SEARXNG_AUTH_PASSWORD;
const originalFetch = globalThis.fetch;

function restoreEnvironment() {
  if (originalProvider === undefined) delete process.env.LINE_WEB_SEARCH_PROVIDER;
  else process.env.LINE_WEB_SEARCH_PROVIDER = originalProvider;
  if (originalApiKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalApiKey;
  if (originalSearxngBaseUrl === undefined) delete process.env.SEARXNG_BASE_URL;
  else process.env.SEARXNG_BASE_URL = originalSearxngBaseUrl;
  if (originalSearxngAuthUsername === undefined) delete process.env.SEARXNG_AUTH_USERNAME;
  else process.env.SEARXNG_AUTH_USERNAME = originalSearxngAuthUsername;
  if (originalSearxngAuthPassword === undefined) delete process.env.SEARXNG_AUTH_PASSWORD;
  else process.env.SEARXNG_AUTH_PASSWORD = originalSearxngAuthPassword;
  globalThis.fetch = originalFetch;
}

test("defaults LINE retrieval to Google News RSS unless a provider is explicitly selected", () => {
  try {
    delete process.env.LINE_WEB_SEARCH_PROVIDER;
    assert.equal(getLineWebSearchProvider(), "google_news_rss");
    process.env.LINE_WEB_SEARCH_PROVIDER = "google_news_rss";
    assert.equal(getLineWebSearchProvider(), "google_news_rss");
    process.env.LINE_WEB_SEARCH_PROVIDER = "brave";
    assert.equal(getLineWebSearchProvider(), "brave");
    process.env.LINE_WEB_SEARCH_PROVIDER = "searxng";
    assert.equal(getLineWebSearchProvider(), "searxng");
  } finally {
    restoreEnvironment();
  }
});

test("routes the default LINE search to Google News RSS", async () => {
  delete process.env.LINE_WEB_SEARCH_PROVIDER;
  globalThis.fetch = async () => new Response(
    "<rss><channel><item><title>RSS fixture</title><link>https://example.com/rss</link><description>Fixture snippet</description></item></channel></rss>",
    { status: 200 },
  );
  try {
    const results = await searchLineWeb("fixed fixture query");
    assert.equal(results[0]?.title, "RSS fixture");
  } finally {
    restoreEnvironment();
  }
});

test("uses the selected Brave provider and never silently falls back", async () => {
  process.env.LINE_WEB_SEARCH_PROVIDER = "brave";
  delete process.env.BRAVE_SEARCH_API_KEY;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Unexpected network request");
  };
  try {
    const diagnostic = await diagnoseLineWebSearch();
    assert.equal(diagnostic.provider, "brave");
    assert.equal(diagnostic.failureKind, "configuration_error");
    await assert.rejects(searchLineWeb("a test query"), {
      name: "WebSearchProviderConfigurationError",
    });
    assert.equal(fetchCalls, 0);
  } finally {
    restoreEnvironment();
  }
});

test("routes calls to the selected provider", async () => {
  process.env.LINE_WEB_SEARCH_PROVIDER = "brave";
  process.env.BRAVE_SEARCH_API_KEY = "test-brave-key";
  globalThis.fetch = async () => new Response(JSON.stringify({
    web: {
      results: [{
        title: "Test result",
        url: "https://example.com/test",
        description: "Test snippet.",
      }],
    },
  }), { status: 200 });
  try {
    const results = await searchLineWeb("fixed fixture query");
    assert.equal(results[0]?.title, "Test result");
  } finally {
    restoreEnvironment();
  }
});

test("uses SearXNG only when selected and reports missing instance configuration", async () => {
  process.env.LINE_WEB_SEARCH_PROVIDER = "searxng";
  delete process.env.SEARXNG_BASE_URL;
  delete process.env.SEARXNG_AUTH_USERNAME;
  delete process.env.SEARXNG_AUTH_PASSWORD;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Unexpected network request");
  };
  try {
    const diagnostic = await diagnoseLineWebSearch();
    assert.equal(diagnostic.provider, "searxng");
    assert.equal(diagnostic.failureKind, "configuration_error");
    await assert.rejects(searchLineWeb("a test query"), {
      name: "WebSearchProviderConfigurationError",
    });
    assert.equal(fetchCalls, 0);
  } finally {
    restoreEnvironment();
  }
});

test("routes selected SearXNG searches through the configured JSON API", async () => {
  process.env.LINE_WEB_SEARCH_PROVIDER = "searxng";
  process.env.SEARXNG_BASE_URL = "https://search.example.org/searx/";
  process.env.SEARXNG_AUTH_USERNAME = "api-user";
  process.env.SEARXNG_AUTH_PASSWORD = "private-test-password";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.href, "https://search.example.org/searx/search?q=fixture+query&format=json");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Basic ${Buffer.from("api-user:private-test-password").toString("base64")}`,
    );
    return new Response(JSON.stringify({
      results: [{
        title: "SearXNG fixture",
        url: "https://example.org/result",
        content: "Fixture summary.",
      }],
    }), { status: 200 });
  };
  try {
    const results = await searchLineWeb("fixture query");
    assert.equal(results[0]?.title, "SearXNG fixture");
    assert.equal(results[0]?.snippet, "Fixture summary.");
  } finally {
    restoreEnvironment();
  }
});
