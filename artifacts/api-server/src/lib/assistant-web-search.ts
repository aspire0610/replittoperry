import type {
  AssistantChatReply,
  AssistantChatSource,
} from "@workspace/api-zod";

export type AssistantWebSearchResult = {
  status: AssistantChatReply["searchStatus"];
  summary: string | null;
  sources: AssistantChatSource[];
  provider: "google_news_rss" | "duckduckgo" | "brave" | "searxng" | null;
  diagnostic?: {
    provider: "google_news_rss" | "duckduckgo" | "brave" | "searxng";
    outcome: "searched" | "empty" | "failed";
    resultCount?: number;
    failureKind?: "configuration_error" | "http_error" | "timeout" | "network_error";
    httpStatus?: number;
    attempts?: WebSearchAttempt[];
  };
};

type WebSearchResult = { title: string; url: string; snippet: string; publishedAt?: string };
type WebSearch = (question: string) => Promise<WebSearchResult[]>;
type WebSearchProvider = "google_news_rss" | "duckduckgo" | "brave" | "searxng";
type WebSearchAttempt = {
  provider: WebSearchProvider;
  outcome: "searched" | "empty" | "failed";
  resultCount?: number;
  failureKind?: "configuration_error" | "http_error" | "timeout" | "network_error";
  httpStatus?: number;
};
type WebSearchFallback = {
  provider: WebSearchProvider;
  webSearch: WebSearch;
};

async function runSearch(
  question: string,
  webSearch: WebSearch,
  provider: WebSearchProvider,
): Promise<{ results: WebSearchResult[]; diagnostic: WebSearchAttempt }> {
  try {
    const results = await webSearch(question);
    return {
      results,
      diagnostic: {
        provider,
        outcome: results.length ? "searched" : "empty",
        resultCount: results.length,
      },
    };
  } catch (error) {
    return {
      results: [],
      diagnostic: {
        provider,
        outcome: "failed",
        ...getSafeFailureDetails(error),
      },
    };
  }
}

function searchedResult(
  results: WebSearchResult[],
  provider: WebSearchProvider,
  diagnostic: AssistantWebSearchResult["diagnostic"],
): AssistantWebSearchResult {
  return {
    status: "searched",
    summary: [
      `以下為 ${getProviderLabel(provider)} 搜尋結果的標題與摘錄，可能不完整，並非完整網頁內容：`,
      ...results.map(
        ({ title, snippet, publishedAt }, index) => {
          const publishedAtLabel = publishedAt
            ? new Intl.DateTimeFormat("zh-TW", {
                timeZone: "Asia/Taipei",
                dateStyle: "short",
                timeStyle: "short",
              }).format(new Date(publishedAt))
            : null;
          return `[${index + 1}]${publishedAtLabel ? ` 發布時間 ${publishedAtLabel} 台灣時間` : ""} ${title}: ${snippet}`;
        },
      ),
    ].join("\n").slice(0, 7_000),
    sources: results.map(({ title, url }) => ({ title, url })),
    provider,
    diagnostic,
  };
}

function getProviderLabel(provider: "google_news_rss" | "duckduckgo" | "brave" | "searxng"): string {
  if (provider === "google_news_rss") return "Google News RSS";
  if (provider === "brave") return "Brave Search";
  if (provider === "searxng") return "SearXNG";
  return "DuckDuckGo";
}

function getSafeFailureDetails(error: unknown): {
  failureKind: "configuration_error" | "http_error" | "timeout" | "network_error";
  httpStatus?: number;
} {
  if (
    error instanceof Error &&
    error.name === "WebSearchProviderConfigurationError"
  ) {
    return { failureKind: "configuration_error" };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return { failureKind: "timeout" };
  }
  if (error instanceof Error) {
    const status = error.message.match(/^(?:DuckDuckGo|Brave|SearXNG|Google News RSS) search returned HTTP ([1-5]\d{2})$/u);
    if (status) {
      return { failureKind: "http_error", httpStatus: Number(status[1]) };
    }
  }
  return { failureKind: "network_error" };
}

export async function searchAssistantWeb(
  question: string,
  webSearch: WebSearch,
  requestId?: string | number,
  provider: WebSearchProvider = "duckduckgo",
  fallback?: WebSearchFallback,
): Promise<AssistantWebSearchResult> {
  const primary = await runSearch(question, webSearch, provider);
  if (primary.results.length) {
    return searchedResult(primary.results, provider, primary.diagnostic);
  }

  if (fallback && fallback.provider !== provider) {
    const secondary = await runSearch(
      question,
      fallback.webSearch,
      fallback.provider,
    );
    const attempts = [primary.diagnostic, secondary.diagnostic];
    if (secondary.results.length) {
      return searchedResult(secondary.results, fallback.provider, {
        ...secondary.diagnostic,
        attempts,
      });
    }
    return {
      status: "unavailable",
      summary: null,
      sources: [],
      provider: null,
      diagnostic: { ...secondary.diagnostic, attempts },
    };
  }

  return {
    status: "unavailable",
    summary: null,
    sources: [],
    provider: null,
    diagnostic: primary.diagnostic,
  };
}
