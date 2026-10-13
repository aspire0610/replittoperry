const MAX_REDIRECTS = 3;
const ALLOWED_OFFICIAL_HOSTS = new Set([
  "twse.com.tw",
  "www.twse.com.tw",
  "tpex.org.tw",
  "www.tpex.org.tw",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type OfficialExchange = "twse" | "tpex";
type FetchLike = typeof fetch;

const MAX_ATTEMPTS: Record<OfficialExchange, number> = {
  twse: 3,
  tpex: 3,
};
const MAX_REDIRECT_WITHOUT_LOCATION_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS: Record<OfficialExchange, number> = {
  twse: 12_000,
  tpex: 45_000,
};

function exchangeLabel(exchange: OfficialExchange): string {
  return exchange === "twse" ? "TWSE" : "TPEx";
}

function isAllowedOfficialUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    ALLOWED_OFFICIAL_HOSTS.has(url.hostname.toLowerCase())
  );
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  return cause === undefined
    ? error.message
    : `${error.message}: ${errorMessage(cause)}`;
}

export type OfficialJsonFetchRetry = {
  nextAttempt: number;
  maxAttempts: number;
  delayMs: number;
};

export type OfficialJsonFetchOptions = {
  onRetry?: (retry: OfficialJsonFetchRetry) => void;
  sleep?: (milliseconds: number) => Promise<void>;
};

function isRetryableError(error: unknown): boolean {
  const message = errorMessage(error);
  if (
    /not an approved HTTPS host|redirected to a non-official host|exceeded \d+-redirect limit|returned HTTP (?:400|401|403|404)\b/i.test(
      message,
    )
  ) {
    return false;
  }
  return /without a Location header|timed out|timeout|connection|socket|terminated|other side closed|econnreset|broken pipe|invalid JSON response|fetch failed|eai_again|enotfound|returned HTTP (?:408|425|429|5\d\d)\b/i.test(
    message,
  );
}

function retryDelayMs(attempt: number, error: unknown): number {
  if (/HTTP 307 without a Location header/i.test(errorMessage(error))) {
    return Math.min(1_000 * 2 ** attempt, 8_000);
  }
  return Math.min(500 * 2 ** attempt, 4_000);
}

function maxAttemptsFor(
  exchange: OfficialExchange,
  error: unknown,
): number {
  return exchange === "twse" &&
    /HTTP 307 without a Location header/i.test(errorMessage(error))
    ? MAX_REDIRECT_WITHOUT_LOCATION_ATTEMPTS
    : MAX_ATTEMPTS[exchange];
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The response is being discarded before retrying or following a redirect.
  }
}

async function requestOfficialJson(
  sourceUrl: URL,
  exchange: OfficialExchange,
  date: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<unknown> {
  const label = exchangeLabel(exchange);
  let currentUrl = new URL(sourceUrl);

  if (!isAllowedOfficialUrl(currentUrl)) {
    throw new Error(`${label} request URL is not an approved HTTPS host.`);
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (parentSignal?.aborted) {
      throw parentSignal.reason instanceof Error
        ? parentSignal.reason
        : new Error(`${label} ${date} request was cancelled.`);
    }
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, timeoutSignal])
      : timeoutSignal;
    const response = await fetchImpl(currentUrl, {
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        Referer:
          exchange === "twse"
            ? "https://www.twse.com.tw/zh/"
            : "https://www.tpex.org.tw/",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal,
      redirect: "manual",
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        await cancelResponseBody(response);
        throw new Error(
          `${label} ${date} returned HTTP ${response.status} without a Location header.`,
        );
      }
      if (redirects === MAX_REDIRECTS) {
        await cancelResponseBody(response);
        throw new Error(
          `${label} ${date} exceeded the ${MAX_REDIRECTS}-redirect limit.`,
        );
      }

      const nextUrl = new URL(location, currentUrl);
      if (!isAllowedOfficialUrl(nextUrl)) {
        await cancelResponseBody(response);
        throw new Error(
          `${label} ${date} redirected to a non-official host (${nextUrl.hostname}).`,
        );
      }

      await cancelResponseBody(response);
      currentUrl = nextUrl;
      continue;
    }

    if (!response.ok) {
      const status = response.status;
      await cancelResponseBody(response);
      throw new Error(
        `${label} ${date} returned HTTP ${status} from ${currentUrl.hostname}${currentUrl.pathname}.`,
      );
    }

    try {
      return await response.json();
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      const detail = errorMessage(error);
      if (
        timeoutSignal.aborted ||
        /timeout|timed out/i.test(detail)
      ) {
        throw new Error(
          `${label} ${date} response body timed out after ${timeoutMs / 1_000} seconds.`,
          { cause: error },
        );
      }
      if (
        /terminated|socket|connection|other side closed|econnreset|broken pipe/i.test(
          detail,
        )
      ) {
        throw new Error(
          `${label} ${date} response body connection was interrupted.`,
          { cause: error },
        );
      }
      throw new Error(
        `${label} ${date} returned an invalid JSON response.`,
        { cause: error },
      );
    }
  }

  throw new Error(`${label} ${date} did not return a final response.`);
}

export async function fetchOfficialJson(
  url: URL,
  exchange: OfficialExchange,
  date: string,
  fetchImpl: FetchLike = fetch,
  parentSignal?: AbortSignal,
  options: OfficialJsonFetchOptions = {},
): Promise<unknown> {
  let lastError: unknown;
  let attemptsMade = 0;
  const label = exchangeLabel(exchange);
  const timeoutMs = REQUEST_TIMEOUT_MS[exchange];
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (
    let attempt = 0;
    attempt < MAX_REDIRECT_WITHOUT_LOCATION_ATTEMPTS;
    attempt += 1
  ) {
    if (parentSignal?.aborted) {
      throw parentSignal.reason instanceof Error
        ? parentSignal.reason
        : new Error(`${label} ${date} request was cancelled.`);
    }
    try {
      return await requestOfficialJson(
        url,
        exchange,
        date,
        fetchImpl,
        timeoutMs,
        parentSignal,
      );
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      lastError = error;
      attemptsMade = attempt + 1;
      const maxAttempts = maxAttemptsFor(exchange, error);
      if (attempt + 1 >= maxAttempts || !isRetryableError(error)) break;
      const delayMs = retryDelayMs(attempt, error);
      options.onRetry?.({
        nextAttempt: attempt + 2,
        maxAttempts,
        delayMs,
      });
      await sleep(delayMs);
    }
  }

  const attemptLabel = attemptsMade === 1 ? "attempt" : "attempts";
  throw new Error(
    `${label} ${date} official daily data request failed after ${attemptsMade} ${attemptLabel}: ${errorMessage(lastError)}`,
    { cause: lastError },
  );
}
