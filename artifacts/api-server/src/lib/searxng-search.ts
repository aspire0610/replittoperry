import {
  WebSearchProviderConfigurationError,
  type WebSearchFailureKind,
} from "./web-search-common.js";

export type SearxngSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export type SearxngAvailabilityDiagnostic = {
  provider: "searxng";
  outcome: "searched" | "empty" | "failed";
  resultCount: number;
  failureKind: WebSearchFailureKind | null;
  httpStatus: number | null;
  checkedAt: string;
};

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

export function parseSearxngSearchResponse(payload: unknown): SearxngSearchResult[] {
  if (!payload || typeof payload !== "object") return [];
  const rawResults = (payload as { results?: unknown }).results;
  if (!Array.isArray(rawResults)) return [];

  const results: SearxngSearchResult[] = [];
  const seenUrls = new Set<string>();
  for (const item of rawResults) {
    if (!item || typeof item !== "object") continue;
    const row = item as { title?: unknown; url?: unknown; content?: unknown };
    const title = cleanText(row.title, 180);
    const snippet = cleanText(row.content, 500);
    const url = safeResultUrl(row.url);
    if (!title || !snippet || !url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    results.push({ title, url, snippet });
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}

function getSearxngSearchUrl(): URL {
  const configured = process.env.SEARXNG_BASE_URL?.trim();
  if (!configured) throw new WebSearchProviderConfigurationError();

  let baseUrl: URL;
  try {
    baseUrl = new URL(configured);
  } catch {
    throw new WebSearchProviderConfigurationError();
  }
  if (
    baseUrl.protocol !== "https:" ||
    !baseUrl.hostname ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new WebSearchProviderConfigurationError();
  }
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  return new URL("search", baseUrl);
}

function getSearxngAuthorizationHeader(): string | null {
  const username = process.env.SEARXNG_AUTH_USERNAME;
  const password = process.env.SEARXNG_AUTH_PASSWORD;
  if (username === undefined && password === undefined) return null;
  if (
    !username?.trim() ||
    password === undefined ||
    password.length === 0 ||
    username.includes(":") ||
    /[\r\n]/.test(username)
  ) {
    throw new WebSearchProviderConfigurationError();
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function fetchSearxngResults(
  query: string,
): Promise<{ results: SearxngSearchResult[]; httpStatus: number }> {
  const url = getSearxngSearchUrl();
  url.searchParams.set("q", query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH));
  url.searchParams.set("format", "json");

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
  };
  const authorization = getSearxngAuthorizationHeader();
  if (authorization) headers.Authorization = authorization;

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`SearXNG search returned HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_LENGTH) {
    throw new Error("SearXNG search response exceeded the size limit");
  }
  const body = await response.text();
  if (body.length > MAX_RESPONSE_LENGTH) {
    throw new Error("SearXNG search response exceeded the size limit");
  }
  return {
    results: parseSearxngSearchResponse(JSON.parse(body)),
    httpStatus: response.status,
  };
}

export async function searchSearxng(query: string): Promise<SearxngSearchResult[]> {
  return (await fetchSearxngResults(query)).results;
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
    ? error.message.match(/^SearXNG search returned HTTP ([1-5]\d{2})$/)
    : null;
  if (status) {
    return { failureKind: "http_error", httpStatus: Number(status[1]) };
  }
  return { failureKind: "network_error", httpStatus: null };
}

export async function diagnoseSearxngAvailability(): Promise<SearxngAvailabilityDiagnostic> {
  try {
    const { results, httpStatus } = await fetchSearxngResults(ADMIN_DIAGNOSTIC_QUERY);
    return {
      provider: "searxng",
      outcome: results.length > 0 ? "searched" : "empty",
      resultCount: results.length,
      failureKind: null,
      httpStatus,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      provider: "searxng",
      outcome: "failed",
      resultCount: 0,
      ...getSafeFailure(error),
      checkedAt: new Date().toISOString(),
    };
  }
}
