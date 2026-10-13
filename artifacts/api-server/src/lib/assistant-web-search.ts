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
  };
};

type WebSearchResult = { title: string; url: string; snippet: string };
type WebSearch = (question: string) => Promise<WebSearchResult[]>;

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
  provider: "google_news_rss" | "duckduckgo" | "brave" | "searxng" = "duckduckgo",
): Promise<AssistantWebSearchResult> {
  let diagnostic: AssistantWebSearchResult["diagnostic"];
  try {
    const results = await webSearch(question);
    if (results.length) {
      return {
        status: "searched",
        summary: [
          `以下為 ${getProviderLabel(provider)} 搜尋結果的標題與摘錄，可能不完整，並非完整網頁內容：`,
          ...results.map(
            ({ title, snippet }, index) => `[${index + 1}] ${title}: ${snippet}`,
          ),
        ].join("\n").slice(0, 7_000),
        sources: results.map(({ title, url }) => ({ title, url })),
        provider,
        diagnostic: { provider, outcome: "searched", resultCount: results.length },
      };
    }
    diagnostic = { provider, outcome: "empty", resultCount: 0 };
  } catch (error) {
    diagnostic = { provider, outcome: "failed", ...getSafeFailureDetails(error) };
  }
  return {
    status: "unavailable",
    summary: null,
    sources: [],
    provider: null,
    diagnostic,
  };
}
