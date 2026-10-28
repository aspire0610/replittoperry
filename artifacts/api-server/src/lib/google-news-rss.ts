import type { WebSearchFailureKind } from "./web-search-common.js";

export type GoogleNewsRssResult = {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
};

export type GoogleNewsRssAvailabilityDiagnostic = {
  provider: "google_news_rss";
  outcome: "searched" | "empty" | "failed";
  resultCount: number;
  failureKind: WebSearchFailureKind | null;
  httpStatus: number | null;
  checkedAt: string;
};

const GOOGLE_NEWS_RSS_URL = "https://news.google.com/rss/search";
const ADMIN_DIAGNOSTIC_QUERY = "Taiwan stock market news";
const MAX_SEARCH_QUERY_LENGTH = 400;
const MAX_RESPONSE_LENGTH = 1_000_000;
const MAX_RESULTS = 5;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;|&#xA0;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&apos;|&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : " ";
    })
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : " ";
    });
}

function cleanXmlText(value: string, maxLength: number): string {
  const unwrapped = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1");
  return decodeXmlEntities(decodeXmlEntities(unwrapped).replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .replace(/\s+([，。；：！？、])/gu, "$1")
    .trim()
    .slice(0, maxLength);
}

function readTag(xml: string, tag: "title" | "link" | "description" | "pubDate"): string {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, "iu"),
  );
  return match?.[1] ?? "";
}

function safeResultUrl(value: string): string | null {
  try {
    const url = new URL(decodeXmlEntities(value.trim()));
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      return null;
    }
    return url.toString().slice(0, 1_000);
  } catch {
    return null;
  }
}

export function parseGoogleNewsRss(xml: string): GoogleNewsRssResult[] {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item\s*>/giu) ?? [];
  const results: GoogleNewsRssResult[] = [];
  const seenUrls = new Set<string>();

  for (const item of items) {
    const title = cleanXmlText(readTag(item, "title"), 180);
    const url = safeResultUrl(readTag(item, "link"));
    const snippet = cleanXmlText(readTag(item, "description"), 500);
    if (!title || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const rawPublishedAt = cleanXmlText(readTag(item, "pubDate"), 100);
    const publishedAtMs = rawPublishedAt ? Date.parse(rawPublishedAt) : Number.NaN;
    results.push({
      title,
      url,
      snippet,
      ...(Number.isFinite(publishedAtMs)
        ? { publishedAt: new Date(publishedAtMs).toISOString() }
        : {}),
    });
    if (results.length === MAX_RESULTS) break;
  }

  return results;
}

async function fetchGoogleNewsRss(
  query: string,
): Promise<{ results: GoogleNewsRssResult[]; httpStatus: number }> {
  const normalizedQuery = query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
  if (!normalizedQuery) return { results: [], httpStatus: 200 };

  const url = new URL(GOOGLE_NEWS_RSS_URL);
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("hl", "zh-TW");
  url.searchParams.set("gl", "TW");
  url.searchParams.set("ceid", "TW:zh-Hant");

  const response = await fetch(url, {
    headers: {
      Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "User-Agent": "TaiwanStockDashboard/1.0",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`Google News RSS search returned HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_LENGTH) {
    throw new Error("Google News RSS response exceeded the size limit");
  }
  const xml = await response.text();
  if (xml.length > MAX_RESPONSE_LENGTH) {
    throw new Error("Google News RSS response exceeded the size limit");
  }

  return { results: parseGoogleNewsRss(xml), httpStatus: response.status };
}

export async function searchGoogleNewsRss(
  query: string,
): Promise<GoogleNewsRssResult[]> {
  return (await fetchGoogleNewsRss(query)).results;
}

function getSafeFailure(error: unknown): {
  failureKind: WebSearchFailureKind;
  httpStatus: number | null;
} {
  if (error instanceof Error && error.name === "TimeoutError") {
    return { failureKind: "timeout", httpStatus: null };
  }
  const status = error instanceof Error
    ? error.message.match(/^Google News RSS search returned HTTP ([1-5]\d{2})$/u)
    : null;
  return status
    ? { failureKind: "http_error", httpStatus: Number(status[1]) }
    : { failureKind: "network_error", httpStatus: null };
}

export async function diagnoseGoogleNewsRssAvailability(): Promise<GoogleNewsRssAvailabilityDiagnostic> {
  try {
    const { results, httpStatus } = await fetchGoogleNewsRss(ADMIN_DIAGNOSTIC_QUERY);
    return {
      provider: "google_news_rss",
      outcome: results.length ? "searched" : "empty",
      resultCount: results.length,
      failureKind: null,
      httpStatus,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      provider: "google_news_rss",
      outcome: "failed",
      resultCount: 0,
      ...getSafeFailure(error),
      checkedAt: new Date().toISOString(),
    };
  }
}
