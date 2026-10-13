import {
  diagnoseBraveAvailability,
  searchBrave,
  type BraveAvailabilityDiagnostic,
  type BraveSearchResult,
} from "./brave-search.js";
import {
  diagnoseDuckDuckGoAvailability,
  searchDuckDuckGo,
  type DuckDuckGoAvailabilityDiagnostic,
  type DuckDuckGoSearchResult,
} from "./duckduckgo-search.js";
import {
  diagnoseSearxngAvailability,
  searchSearxng,
  type SearxngAvailabilityDiagnostic,
  type SearxngSearchResult,
} from "./searxng-search.js";
import {
  diagnoseGoogleNewsRssAvailability,
  searchGoogleNewsRss,
  type GoogleNewsRssAvailabilityDiagnostic,
  type GoogleNewsRssResult,
} from "./google-news-rss.js";
import type { WebSearchFailureKind } from "./web-search-common.js";

export type LineWebSearchProvider =
  | "google_news_rss"
  | "duckduckgo"
  | "brave"
  | "searxng";
export type LineWebSearchResult =
  | GoogleNewsRssResult
  | BraveSearchResult
  | DuckDuckGoSearchResult
  | SearxngSearchResult;
export type LineWebSearchDiagnostic =
  | GoogleNewsRssAvailabilityDiagnostic
  | BraveAvailabilityDiagnostic
  | DuckDuckGoAvailabilityDiagnostic
  | SearxngAvailabilityDiagnostic;

export function getLineWebSearchProvider(): LineWebSearchProvider {
  const configured = process.env.LINE_WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  if (!configured || configured === "google_news_rss") return "google_news_rss";
  if (configured === "duckduckgo") return "duckduckgo";
  if (configured === "brave") return "brave";
  if (configured === "searxng") return "searxng";
  throw new Error("LINE_WEB_SEARCH_PROVIDER must be google_news_rss, duckduckgo, brave, or searxng.");
}

export async function searchLineWeb(
  query: string,
): Promise<LineWebSearchResult[]> {
  const provider = getLineWebSearchProvider();
  if (provider === "google_news_rss") return searchGoogleNewsRss(query);
  if (provider === "brave") return searchBrave(query);
  if (provider === "searxng") return searchSearxng(query);
  return searchDuckDuckGo(query);
}

export async function diagnoseLineWebSearch(): Promise<LineWebSearchDiagnostic> {
  const provider = getLineWebSearchProvider();
  if (provider === "google_news_rss") return diagnoseGoogleNewsRssAvailability();
  if (provider === "brave") return diagnoseBraveAvailability();
  if (provider === "searxng") return diagnoseSearxngAvailability();
  return diagnoseDuckDuckGoAvailability();
}

export type LineWebSearchFailureKind = WebSearchFailureKind;
