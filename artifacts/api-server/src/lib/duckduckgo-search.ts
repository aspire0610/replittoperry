export type DuckDuckGoSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

const DUCKDUCKGO_HTML_SEARCH_URL = "https://html.duckduckgo.com/html/";
const MAX_SEARCH_QUERY_LENGTH = 400;
const MAX_RESPONSE_LENGTH = 1_000_000;
const ADMIN_DIAGNOSTIC_QUERY = "Taiwan stock market news";

export type DuckDuckGoAvailabilityDiagnostic = {
  provider: "duckduckgo";
  outcome: "searched" | "empty" | "failed";
  resultCount: number;
  failureKind: "http_error" | "timeout" | "network_error" | null;
  httpStatus: number | null;
  checkedAt: string;
};

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : " ";
    });
}

function cleanHtmlText(value: string, maxLength: number): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function hasClass(attributes: string, className: string): boolean {
  const classMatch = attributes.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const classes = (classMatch?.[1] ?? classMatch?.[2] ?? "").split(/\s+/);
  return classes.includes(className);
}

function getAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function findResultBlocks(html: string): string[] {
  const blocks: string[] = [];
  const stack: Array<{ start: number; isResult: boolean }> = [];
  const tags = /<\/?div\b[^>]*>/gi;

  for (const match of html.matchAll(tags)) {
    const tag = match[0]!;
    if (/^<\//.test(tag)) {
      const frame = stack.pop();
      if (frame?.isResult) {
        blocks.push(html.slice(frame.start, match.index! + tag.length));
      }
      continue;
    }
    const isResult = hasClass(tag, "result") && hasClass(tag, "results_links");
    stack.push({ start: match.index!, isResult });
  }

  return blocks;
}

function findAnchor(
  block: string,
  className: string,
): { href: string; text: string } | null {
  for (const match of block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attributes = match[1]!;
    if (!hasClass(attributes, className)) continue;
    const href = getAttribute(attributes, "href");
    if (!href) return null;
    return { href, text: match[2]! };
  }
  return null;
}

function normalizeResultUrl(href: string): string | null {
  try {
    const redirect = new URL(decodeHtmlEntities(href), DUCKDUCKGO_HTML_SEARCH_URL);
    const isDuckDuckGo =
      redirect.hostname === "duckduckgo.com" ||
      redirect.hostname.endsWith(".duckduckgo.com");
    const target =
      isDuckDuckGo && redirect.pathname.startsWith("/l/")
        ? redirect.searchParams.get("uddg")
        : isDuckDuckGo
          ? null
          : redirect.toString();
    if (!target) return null;

    const url = new URL(target);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hostname === "duckduckgo.com" ||
      url.hostname.endsWith(".duckduckgo.com")
    ) {
      return null;
    }
    return url.toString().slice(0, 1_000);
  } catch {
    return null;
  }
}

export function parseDuckDuckGoSearchHtml(
  html: string,
): DuckDuckGoSearchResult[] {
  const results: DuckDuckGoSearchResult[] = [];
  const seenUrls = new Set<string>();

  for (const block of findResultBlocks(html)) {
    const titleAnchor = findAnchor(block, "result__a");
    const snippetAnchor = findAnchor(block, "result__snippet");
    if (!titleAnchor || !snippetAnchor) continue;

    const title = cleanHtmlText(titleAnchor.text, 180);
    const snippet = cleanHtmlText(snippetAnchor.text, 500);
    const url = normalizeResultUrl(titleAnchor.href);
    if (!title || !snippet || !url || seenUrls.has(url)) continue;

    seenUrls.add(url);
    results.push({ title, url, snippet });
    if (results.length === 5) break;
  }

  return results;
}

async function fetchDuckDuckGoHtml(
  query: string,
): Promise<{ html: string; httpStatus: number }> {
  const normalizedQuery = query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
  if (!normalizedQuery) return { html: "", httpStatus: 200 };

  const url = new URL(DUCKDUCKGO_HTML_SEARCH_URL);
  url.searchParams.set("q", normalizedQuery);

  const response = await fetch(url, {
    headers: {
      Accept: "text/html",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      "User-Agent": "Mozilla/5.0 (compatible; TaiwanStockDashboard/1.0)",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo search returned HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_LENGTH) {
    throw new Error("DuckDuckGo search response exceeded the size limit");
  }

  const html = await response.text();
  if (html.length > MAX_RESPONSE_LENGTH) {
    throw new Error("DuckDuckGo search response exceeded the size limit");
  }
  return { html, httpStatus: response.status };
}

export async function searchDuckDuckGo(
  query: string,
): Promise<DuckDuckGoSearchResult[]> {
  const { html } = await fetchDuckDuckGoHtml(query);
  return parseDuckDuckGoSearchHtml(html);
}

export async function diagnoseDuckDuckGoAvailability(): Promise<DuckDuckGoAvailabilityDiagnostic> {
  try {
    const { html, httpStatus } = await fetchDuckDuckGoHtml(ADMIN_DIAGNOSTIC_QUERY);
    const resultCount = parseDuckDuckGoSearchHtml(html).length;
    return {
      provider: "duckduckgo",
      outcome: resultCount > 0 ? "searched" : "empty",
      resultCount,
      failureKind: null,
      httpStatus,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const status = error instanceof Error
      ? error.message.match(/^DuckDuckGo search returned HTTP ([1-5]\d{2})$/)
      : null;
    const failureKind = error instanceof Error && error.name === "TimeoutError"
      ? "timeout"
      : status
        ? "http_error"
        : "network_error";
    return {
      provider: "duckduckgo",
      outcome: "failed",
      resultCount: 0,
      failureKind,
      httpStatus: status ? Number(status[1]) : null,
      checkedAt: new Date().toISOString(),
    };
  }
}
