import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnoseGoogleNewsRssAvailability,
  parseGoogleNewsRss,
  searchGoogleNewsRss,
} from "./google-news-rss.ts";

const originalFetch = globalThis.fetch;

test("parses safe Google News RSS entries, decodes XML and limits results", () => {
  const entries = Array.from({ length: 7 }, (_, index) => `
    <item>
      <title><![CDATA[台股 &amp; 市場 ${index}]]></title>
      <link>https://news.google.com/rss/articles/${index}</link>
      <description><![CDATA[<a>來源</a>：摘錄 &amp; 摘要 ${index}]]></description>
      <pubDate>Wed, 21 Oct 2026 02:00:00 GMT</pubDate>
    </item>
  `).join("");
  const parsed = parseGoogleNewsRss(`<rss><channel>${entries}</channel></rss>`);

  assert.equal(parsed.length, 5);
  assert.equal(parsed[0].title, "台股 & 市場 0");
  assert.equal(parsed[0].snippet, "來源：摘錄 & 摘要 0");
  assert.equal(parsed[0].url, "https://news.google.com/rss/articles/0");
  assert.equal(parsed[0].publishedAt, "2026-10-21T02:00:00.000Z");
});

test("rejects unsafe links and duplicate RSS entries", () => {
  const xml = `
    <item><title>Unsafe</title><link>javascript:alert(1)</link><description>bad</description></item>
    <item><title>First</title><link>https://news.example.com/story</link><description>ok</description></item>
    <item><title>Duplicate</title><link>https://news.example.com/story</link><description>duplicate</description></item>
  `;

  assert.deepEqual(parseGoogleNewsRss(xml), [{
    title: "First",
    url: "https://news.example.com/story",
    snippet: "ok",
  }]);
});

test("sends Taiwan-localized queries and returns parsed feed entries", async () => {
  let requestedUrl;
  globalThis.fetch = async (input, init) => {
    requestedUrl = new URL(String(input));
    assert.equal(new Headers(init?.headers).get("accept-language"), "zh-TW,zh;q=0.9,en;q=0.8");
    return new Response(
      "<rss><channel><item><title>標題</title><link>https://example.com/a</link><description>摘要</description></item></channel></rss>",
      { status: 200 },
    );
  };

  try {
    const results = await searchGoogleNewsRss("台股 今日");
    assert.equal(requestedUrl.origin, "https://news.google.com");
    assert.equal(requestedUrl.pathname, "/rss/search");
    assert.equal(requestedUrl.searchParams.get("q"), "台股 今日");
    assert.equal(requestedUrl.searchParams.get("hl"), "zh-TW");
    assert.equal(requestedUrl.searchParams.get("gl"), "TW");
    assert.equal(requestedUrl.searchParams.get("ceid"), "TW:zh-Hant");
    assert.equal(results[0].title, "標題");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fixed-query diagnostic reports metadata only and classifies HTTP failures", async () => {
  let requestedUrl;
  globalThis.fetch = async (input) => {
    requestedUrl = new URL(String(input));
    return new Response(
      "<rss><channel><item><title>Private fixture text</title><link>https://example.com/a</link><description>Private snippet</description></item></channel></rss>",
      { status: 200 },
    );
  };

  try {
    const diagnostic = await diagnoseGoogleNewsRssAvailability();
    assert.equal(requestedUrl.searchParams.get("q"), "Taiwan stock market news");
    assert.deepEqual({
      provider: diagnostic.provider,
      outcome: diagnostic.outcome,
      resultCount: diagnostic.resultCount,
      failureKind: diagnostic.failureKind,
      httpStatus: diagnostic.httpStatus,
    }, {
      provider: "google_news_rss",
      outcome: "searched",
      resultCount: 1,
      failureKind: null,
      httpStatus: 200,
    });
    assert.equal(JSON.stringify(diagnostic).includes("Private"), false);
  } finally {
    globalThis.fetch = async () => new Response("private response", { status: 403 });
  }

  try {
    const failed = await diagnoseGoogleNewsRssAvailability();
    assert.equal(failed.failureKind, "http_error");
    assert.equal(failed.httpStatus, 403);
    assert.equal(JSON.stringify(failed).includes("private response"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
