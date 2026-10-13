import {
  WebSearchProviderConfigurationError,
  type WebSearchFailureKind,
} from "./web-search-common.js";

export type BraveSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type BraveAvailabilityDiagnostic = {
  provider: "brave";
  outcome: "searched" | "empty" | "failed";
  resultCount: number;
  failureKind: WebSearchFailureKind | null;
  httpStatus: number | null;
  checkedAt: string;
};

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const ADMIN_DIAGNOSTIC_QUERY = "Taiwan stock market news";
const MAX_SEARCH_QUERY_LENGTH = 400;
const MAX_RESPONSE_LENGTH = 1_000_000;
const MAX_RESULTS = 5;

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function safeResultUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      return null;
    }
    return url.toString().slice(0, 1_000);
  } catch {
    return null;
  }
}

export function parseBraveSearchResponse(payload: unknown): BraveSearchResult[] {
  if (!payload || typeof payload !== "object") return [];
  const web = (payload as { web?: unknown }).web;
  if (!web || typeof web !== "object") return [];
  const rawResults = (web as { results?: unknown }).results;
  if (!Array.isArray(rawResults)) return [];

  const results: BraveSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const item of rawResults) {
    if (!item || typeof item !== "object") continue;
    const row = item as { title?: unknown; url?: unknown; description?: unknown };
    const title = cleanText(row.title, 180);
    const snippet = cleanText(row.description, 500);
    const url = safeResultUrl(row.url);
    if (!title || !snippet || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    results.push({ title, url, snippet });
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}

async function fetchBraveResults(
  query: string,
): Promise<{ results: BraveSearchResult[]; httpStatus: number }> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) throw new WebSearchProviderConfigurationError();

  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH));
  url.searchParams.set("count", String(MAX_RESULTS));

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`Brave search returned HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_LENGTH) {
    throw new Error("Brave search response exceeded the size limit");
  }
  const body = await response.text();
  if (body.length > MAX_RESPONSE_LENGTH) {
    throw new Error("Brave search response exceeded the size limit");
  }
  return {
    results: parseBraveSearchResponse(JSON.parse(body)),
    httpStatus: response.status,
  };
}

export async function searchBrave(query: string): Promise<BraveSearchResult[]> {
  return (await fetchBraveResults(query)).results;
}

function getSafeFailure(error: unknown): {
  failureKind: WebSearchFailureKind;
  httpStatus: number | null;
} {
  if (error instanceof WebSearchProviderConfigurationError) {
    return { failureKind: "configuration_error", httpStatus: null };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { failureKind: "timeout", httpStatus: null };
  }
  const status = error instanceof Error
    ? error.message.match(/^Brave search returned HTTP ([1-5]\d{2})$/)
    : null;
  if (status) {
    return { failureKind: "http_error", httpStatus: Number(status[1]) };
  }
  return { failureKind: "network_error", httpStatus: null };
}

export async function diagnoseBraveAvailability(): Promise<BraveAvailabilityDiagnostic> {
  try {
    const { results, httpStatus } = await fetchBraveResults(ADMIN_DIAGNOSTIC_QUERY);
    return {
      provider: "brave",
      outcome: results.length > 0 ? "searched" : "empty",
      resultCount: results.length,
      failureKind: null,
      httpStatus,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const failure = getSafeFailure(error);
    return {
      provider: "brave",
      outcome: "failed",
      resultCount: 0,
      ...failure,
      checkedAt: new Date().toISOString(),
    };
  }
}
