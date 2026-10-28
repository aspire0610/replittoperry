import { logger } from "./logger.js";
import OpenAI from "openai";

const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const DEFAULT_FALLBACK_BUDGET_MS = 12_000;
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const UPSTREAM_ERROR_COOLDOWN_MS = 15_000;
const CONFIGURATION_ERROR_COOLDOWN_MS = 5 * 60_000;
type ProviderFailureKind =
  | "timeout"
  | "connection"
  | "http"
  | "invalid_response"
  | "empty_response"
  | "invalid_output";
const providerCooldowns = new Map<
  string,
  { until: number; status: number }
>();

type AiProviderFallbackRequest = {
  operation: string;
  requestId?: string | number;
  instructions: string | string[];
  input: string;
  schema: unknown;
  maxOutputTokens: number;
  /** Restricts providers and sets their priority in the supplied order. */
  allowedProviders?: readonly AiProviderName[];
  timeoutMs?: number;
  maxFallbackDurationMs?: number;
  geminiTimeoutMs?: number;
  geminiModelTimeoutMs?: number;
  geminiModels?: readonly string[];
  groqTimeoutMs?: number;
  groqMaxOutputTokens?: number;
  groqModel?: string;
  oneMinAiTimeoutMs?: number;
  agnesAiTimeoutMs?: number;
  ollamaTimeoutMs?: number;
  openRouterTimeoutMs?: number;
  signal?: AbortSignal;
  validateOutput?: (text: string | null) => boolean;
  onInvalidOutput?: (text: string) => void;
  onProviderProgress?: (event: {
    provider: AiProviderName;
    state: "started" | "succeeded" | "failed" | "skipped";
    message: string;
  }) => void;
};

export type AiProviderName =
  | "openai"
  | "1min_ai"
  | "agnes_ai"
  | "groq"
  | "ollama"
  | "openrouter"
  | "gemini";

export type AiProviderResult = {
  text: string | null;
  provider: AiProviderName;
};

type AgnesAiChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

class AgnesAiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failureKind: ProviderFailureKind = "http",
  ) {
    super(message);
    this.name = "AgnesAiRequestError";
  }
}

class OneMinAiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failureKind: ProviderFailureKind = "http",
  ) {
    super(message);
    this.name = "OneMinAiRequestError";
  }
}

class OllamaRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failureKind: ProviderFailureKind = "http",
  ) {
    super(message);
    this.name = "OllamaRequestError";
  }
}

class OpenRouterRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failureKind: ProviderFailureKind = "http",
  ) {
    super(message);
    this.name = "OpenRouterRequestError";
  }
}

class GeminiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failureKind: ProviderFailureKind = "http",
  ) {
    super(message);
    this.name = "GeminiRequestError";
  }
}

class GroqRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly failureKind: ProviderFailureKind = "http",
  ) {
    super(message);
    this.name = "GroqRequestError";
  }
}

export class AiProviderFallbackError extends Error {
  readonly status: 429 | 502 | 504;

  constructor(message: string, status: 429 | 502 | 504 = 502) {
    super(message);
    this.status = status;
    this.name = "AiProviderFallbackError";
  }
}

class AiProviderAttemptTimeoutError extends Error {
  readonly status = 504;
  readonly failureKind: ProviderFailureKind = "timeout";

  constructor(providerLabel: string) {
    super(`${providerLabel} 分析逾時。`);
    this.name = "AiProviderAttemptTimeoutError";
  }
}

function statusFrom(error: unknown): number | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("status" in error) ||
    typeof error.status !== "number"
  ) {
    return null;
  }
  return error.status;
}

function isTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return false;

    const name =
      "name" in current && typeof current.name === "string"
        ? current.name
        : "";
    const code =
      "code" in current && typeof current.code === "string"
        ? current.code
        : "";
    if (
      /timeout|abort/i.test(name) ||
      ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(
        code,
      )
    ) {
      return true;
    }

    current = "cause" in current ? current.cause : null;
  }
  return false;
}

function providerTimeoutMs(
  provider: AiProviderName,
  request: AiProviderFallbackRequest,
): number {
  switch (provider) {
    case "gemini":
      return (
        request.geminiTimeoutMs ??
        request.timeoutMs ??
        DEFAULT_PROVIDER_TIMEOUT_MS
      );
    case "1min_ai":
      return (
        request.oneMinAiTimeoutMs ??
        request.timeoutMs ??
        DEFAULT_PROVIDER_TIMEOUT_MS
      );
    case "agnes_ai":
      return (
        request.agnesAiTimeoutMs ??
        request.timeoutMs ??
        DEFAULT_PROVIDER_TIMEOUT_MS
      );
    case "ollama":
      return (
        request.ollamaTimeoutMs ??
        request.timeoutMs ??
        DEFAULT_PROVIDER_TIMEOUT_MS
      );
    case "openrouter":
      return (
        request.openRouterTimeoutMs ??
        request.timeoutMs ??
        DEFAULT_PROVIDER_TIMEOUT_MS
      );
    case "groq":
      return Math.min(
        request.groqTimeoutMs ?? request.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        6_000,
      );
    default:
      return request.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  }
}

function requestWithProviderTimeout(
  request: AiProviderFallbackRequest,
  timeoutMs: number,
): AiProviderFallbackRequest {
  return {
    ...request,
    timeoutMs,
    geminiTimeoutMs: timeoutMs,
    oneMinAiTimeoutMs: timeoutMs,
    agnesAiTimeoutMs: timeoutMs,
    ollamaTimeoutMs: timeoutMs,
    openRouterTimeoutMs: timeoutMs,
    groqTimeoutMs: timeoutMs,
  };
}

async function runProviderWithDeadline(
  run: (request: AiProviderFallbackRequest) => Promise<AiProviderResult>,
  request: AiProviderFallbackRequest,
  timeoutMs: number,
  providerLabel: string,
): Promise<AiProviderResult> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new AiProviderAttemptTimeoutError(providerLabel));
    }, timeoutMs);
  });

  try {
    const result = Promise.resolve().then(() =>
      run({ ...request, signal: controller.signal }),
    );
    return await Promise.race([result, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function cooldownForStatus(status: number | null): number {
  if (status === 429) return RATE_LIMIT_COOLDOWN_MS;
  if (status === 402) return CONFIGURATION_ERROR_COOLDOWN_MS;
  if (status !== null && status >= 500 && status <= 599) {
    return UPSTREAM_ERROR_COOLDOWN_MS;
  }
  if (status === 401 || status === 403 || status === 404) {
    return CONFIGURATION_ERROR_COOLDOWN_MS;
  }
  return 0;
}

function safeRequestId(
  requestId: string | number | undefined,
): string | number | null {
  if (typeof requestId === "number") {
    return Number.isSafeInteger(requestId) && requestId >= 0 ? requestId : null;
  }
  return requestId && /^[A-Za-z0-9._-]{1,80}$/.test(requestId)
    ? requestId
    : null;
}

function logProviderDiagnostic(
  event: "AI_PROVIDER_ATTEMPT_STARTED" | "AI_PROVIDER_ATTEMPT_FAILED",
  request: AiProviderFallbackRequest,
  provider: string,
  status?: number | null,
  reason?: string | null,
  durationMs?: number,
): void {
  console.log(
    JSON.stringify({
      event,
      requestId: safeRequestId(request.requestId),
      operation: request.operation,
      provider,
      ...(event === "AI_PROVIDER_ATTEMPT_FAILED"
        ? {
            status: status ?? null,
            ...(reason ? { reason } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
          }
        : {}),
    }),
  );
}

function requestInstructions(request: AiProviderFallbackRequest): string {
  const baseInstructions = Array.isArray(request.instructions)
    ? request.instructions.join("\n")
    : request.instructions;

  return [
    "所有面向使用者的回答先給明確答案或結論，再補最少的必要依據。刪除客套、重述、空話與重複說明；證據足夠就直接表態，證據不足或矛盾就指出具體缺口，不猜測也不強行確定。保留 Schema 必填欄位、來源、日期、條件與必要風險提示。",
    baseInstructions,
    "請只回傳一個有效的 JSON 物件，不要加上 Markdown 或其他文字。",
    `輸出必須符合此 JSON Schema：${JSON.stringify(request.schema)}`,
  ].join("\n\n");
}

function providerFailureSummary(error: unknown, provider: string): string {
  if (error instanceof AiProviderFallbackError) return error.message;
  const status = statusFrom(error);
  const rawFailureKind =
    typeof error === "object" && error !== null && "failureKind" in error
      ? error.failureKind
      : null;
  const failureKind =
    typeof rawFailureKind === "string" &&
    [
      "timeout",
      "connection",
      "http",
      "invalid_response",
      "empty_response",
      "invalid_output",
    ].includes(rawFailureKind)
      ? rawFailureKind
      : null;
  if (status === null) {
    return failureKind
      ? `${provider} ${failureKind}`
      : `${provider} 連線或回覆失敗`;
  }
  return `${provider} HTTP ${status}${failureKind ? ` (${failureKind})` : ""}`;
}

function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function normalizeStructuredJsonOutput(
  text: string,
  validateOutput?: (text: string | null) => boolean,
): string {
  const cleaned = text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, "")
    .trim();
  const fencedJson = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidateSource = fencedJson || cleaned;
  const candidates = jsonObjectCandidates(candidateSource).reverse();

  if (validateOutput) {
    for (const candidate of candidates) {
      if (validateOutput(candidate)) return candidate;
    }
    if (fencedJson && validateOutput(fencedJson)) return fencedJson;
    if (validateOutput(cleaned)) return cleaned;
  }

  return candidates[0] ?? fencedJson ?? cleaned;
}

const GEMINI_MODEL = "gemini-3.5-flash-lite";

async function generateGemini(
  apiKey: string,
  request: AiProviderFallbackRequest,
): Promise<AiProviderResult> {
  const timeout =
    request.geminiTimeoutMs ??
    request.timeoutMs ??
    DEFAULT_PROVIDER_TIMEOUT_MS;
  const modelTimeout =
    request.geminiModelTimeoutMs ?? timeout;
  const models = [...new Set(request.geminiModels ?? [GEMINI_MODEL])];
  let lastError: unknown;
  for (const model of models) {
    try {
      return await generateGeminiModel(apiKey, request, model, modelTimeout);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new GeminiRequestError(
    502,
    "Gemini 目前沒有可用模型。",
    "invalid_response",
  );
}

async function generateGeminiModel(
  apiKey: string,
  request: AiProviderFallbackRequest,
  model: string,
  timeout: number,
): Promise<AiProviderResult> {
  const client = new OpenAI({
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    timeout,
    maxRetries: 0,
    fetch: (...args) => globalThis.fetch(...args),
  });

  let response;
  try {
    response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: requestInstructions(request) },
        { role: "user", content: request.input },
      ],
      response_format: { type: "json_object" },
      max_tokens: request.maxOutputTokens,
      temperature: 0.2,
      stream: false,
    }, request.signal ? { signal: request.signal } : undefined);
  } catch (error) {
    const timedOut = isTimeoutError(error);
    const status = timedOut ? 504 : (statusFrom(error) ?? 502);
    throw new GeminiRequestError(
      status,
      timedOut
        ? "Gemini 分析逾時。"
        : status !== 502
          ? `Gemini 回應 HTTP ${status}。`
          : "Gemini 目前無法連線。",
      timedOut
        ? "timeout"
        : statusFrom(error) !== null
          ? "http"
          : "connection",
    );
  }

  const responseText = response.choices?.[0]?.message?.content?.trim() ?? "";
  const text = normalizeStructuredJsonOutput(
    responseText,
    request.validateOutput,
  );
  if (!text) {
    throw new GeminiRequestError(
      502,
      "Gemini 沒有回傳可用內容。",
      "empty_response",
    );
  }
  if (request.validateOutput && !request.validateOutput(text)) {
    request.onInvalidOutput?.(text);
    throw new GeminiRequestError(
      502,
      "Gemini 回傳內容未通過格式驗證。",
      "invalid_output",
    );
  }

  return { text, provider: "gemini" };
}

async function generateOneMinAi(
  apiKey: string,
  request: AiProviderFallbackRequest,
): Promise<AiProviderResult> {
  const timeout =
    request.oneMinAiTimeoutMs ??
    request.timeoutMs ??
    DEFAULT_PROVIDER_TIMEOUT_MS;
  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.1min.ai/openai/v1",
    timeout,
    maxRetries: 0,
    fetch: (...args) => globalThis.fetch(...args),
  });

  let response;
  try {
    response = await client.chat.completions.create({
      model: "qwen3-8b",
      messages: [
        { role: "system", content: requestInstructions(request) },
        { role: "user", content: request.input },
      ],
      response_format: { type: "json_object" },
      max_tokens: request.maxOutputTokens,
      temperature: 0.2,
      stream: false,
    }, request.signal ? { signal: request.signal } : undefined);
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      ["APIConnectionTimeoutError", "TimeoutError", "AbortError"].includes(
        error.name,
      );
    const status = statusFrom(error) ?? (timedOut ? 504 : 502);
    throw new OneMinAiRequestError(
      status,
      timedOut
        ? "1min.ai 分析逾時。"
        : status !== 502
          ? `1min.ai 回應 HTTP ${status}。`
          : "1min.ai 目前無法連線。",
      timedOut
        ? "timeout"
        : statusFrom(error) !== null
          ? "http"
          : "connection",
    );
  }

  const responseText = response.choices?.[0]?.message?.content?.trim() ?? "";
  const text = normalizeStructuredJsonOutput(
    responseText,
    request.validateOutput,
  );
  if (!text) {
    throw new OneMinAiRequestError(
      502,
      "1min.ai 沒有回傳可用內容。",
      "empty_response",
    );
  }
  if (request.validateOutput && !request.validateOutput(text)) {
    request.onInvalidOutput?.(text);
    throw new OneMinAiRequestError(
      502,
      "1min.ai 回傳內容未通過格式驗證。",
      "invalid_output",
    );
  }

  return { text, provider: "1min_ai" };
}

const OPENROUTER_FREE_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const OPENROUTER_POSITION_DATA_REMOVED =
  "使用者的個人持倉資訊已移除。只根據公開市場資料回答；若問題必須依賴個人持倉資料，請明確說明資料不足，不得推測。";
const OPENROUTER_POSITION_DISCLOSURE_PATTERN =
  /(?:\b(?:my|our)\s+(?:shares?|position|portfolio|holdings?)\b|\b(?:my|our)\b.{0,30}\b\d[\d,.]*\s+(?:shares?|lots?)\b|\b(?:i\s+(?:own|hold|have|bought|purchased))\b.{0,50}\b\d[\d,.]*\s+(?:shares?|lots?)\b|(?:我|本人|自己|目前|手上|帳上).{0,24}(?:持有|持股|持倉|持仓|部位|平均成本|成本價|買進|買入|買了|購入)|(?:持有|持股|持倉|持仓|平均成本|平均買價|均價|持倉成本).{0,30}\d|我有\s*[\d,.]+\s*(?:股|張)|我.{0,15}[\d,.]+\s*(?:股|張))/iu;
const OPENROUTER_POSITION_FIELD_PATTERN =
  /(?:["']?(?:shares(?:held|owned|count)?|heldshares|sharecount|quantity|holdingquantity|positionquantity|(?:average|avg)cost|costbasis|costprice|buyprice|purchaseprice)["']?\s*[:=]\s*["']?\d[\d,.]*|(?:持有股數|持股數|持倉數量|平均成本|平均買價|成本價)\s*[:：=]?\s*[\d,.]+)/iu;
const OPENROUTER_PRIVATE_POSITION_KEYS = new Set([
  "averagecost",
  "averageprice",
  "averagepurchaseprice",
  "averagebuyprice",
  "avgcost",
  "avgprice",
  "avgpurchaseprice",
  "accountholdings",
  "accountportfolio",
  "accountpositions",
  "buyprice",
  "costbasis",
  "costprice",
  "currentholdings",
  "currentposition",
  "currentshares",
  "heldshares",
  "holding",
  "holdinglots",
  "holdingquantity",
  "holdings",
  "holdingvalue",
  "lots",
  "lotsheld",
  "myholdings",
  "myposition",
  "myshares",
  "ownedshares",
  "personalholdings",
  "personalportfolio",
  "personalposition",
  "position",
  "positiondata",
  "positiondetails",
  "portfolio",
  "portfolioholdings",
  "positionlots",
  "positionquantity",
  "positions",
  "positionshares",
  "positionvalue",
  "quantityheld",
  "quantity",
  "shareamount",
  "sharequantity",
  "shares",
  "sharecount",
  "sharesheld",
  "sharesowned",
  "totalshares",
  "totalsharesowned",
  "unitsowned",
  "unrealizedpnl",
  "userholdings",
  "userposition",
  "usershares",
]);

function normalizedJsonKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasPersonalPositionDisclosure(text: string): boolean {
  return (
    OPENROUTER_POSITION_DISCLOSURE_PATTERN.test(text) ||
    OPENROUTER_POSITION_FIELD_PATTERN.test(text)
  );
}

function sanitizeOpenRouterFreeValue(
  value: unknown,
  key = "",
): { value: unknown; removedPositionData: boolean } {
  if (
    key &&
    OPENROUTER_PRIVATE_POSITION_KEYS.has(normalizedJsonKey(key))
  ) {
    return { value: undefined, removedPositionData: true };
  }

  if (typeof value === "string") {
    const hasPrivatePositionData = hasPersonalPositionDisclosure(value);
    return {
      value: hasPrivatePositionData
        ? OPENROUTER_POSITION_DATA_REMOVED
        : value,
      removedPositionData: hasPrivatePositionData,
    };
  }

  if (Array.isArray(value)) {
    let removedPositionData = false;
    const sanitized = value.flatMap((item) => {
      const result = sanitizeOpenRouterFreeValue(item);
      removedPositionData ||= result.removedPositionData;
      return result.value === undefined ? [] : [result.value];
    });
    return { value: sanitized, removedPositionData };
  }

  if (typeof value === "object" && value !== null) {
    let removedPositionData = false;
    const sanitized = Object.fromEntries(
      Object.entries(value).flatMap(([childKey, childValue]) => {
        const result = sanitizeOpenRouterFreeValue(childValue, childKey);
        removedPositionData ||= result.removedPositionData;
        return result.value === undefined ? [] : [[childKey, result.value]];
      }),
    );
    return { value: sanitized, removedPositionData };
  }

  return { value, removedPositionData: false };
}

function sanitizeOpenRouterFreeInput(input: string): {
  input: string;
  removedPositionData: boolean;
} {
  try {
    const parsed = JSON.parse(input) as unknown;
    const result = sanitizeOpenRouterFreeValue(parsed);
    return {
      input: JSON.stringify(result.value),
      removedPositionData: result.removedPositionData,
    };
  } catch {
    const removedPositionData = hasPersonalPositionDisclosure(input);
    return {
      input: removedPositionData
        ? OPENROUTER_POSITION_DATA_REMOVED
        : input,
      removedPositionData,
    };
  }
}

async function generateOpenRouter(
  apiKey: string,
  request: AiProviderFallbackRequest,
): Promise<AiProviderResult> {
  const model = resolveOpenRouterModel();
  const sanitizedInput = sanitizeOpenRouterFreeInput(request.input);
  const timeout =
    request.openRouterTimeoutMs ??
    request.timeoutMs ??
    DEFAULT_PROVIDER_TIMEOUT_MS;
  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout,
    maxRetries: 0,
    fetch: (...args) => globalThis.fetch(...args),
  });

  let response;
  try {
    response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: [
            requestInstructions(request),
            sanitizedInput.removedPositionData
              ? "個人持倉明細已在傳送前移除。不要推測持股數或成本；如問題需要這些資料，請選資料不足。"
              : "不要假設或推測使用者的個人持倉明細；若問題需要持股數或成本，請選資料不足。",
          ].join("\n\n"),
        },
        { role: "user", content: sanitizedInput.input },
      ],
      response_format: { type: "json_object" },
      max_tokens: request.maxOutputTokens,
      temperature: 0.2,
      stream: false,
    }, request.signal ? { signal: request.signal } : undefined);
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      ["APIConnectionTimeoutError", "TimeoutError", "AbortError"].includes(
        error.name,
      );
    const status = statusFrom(error) ?? (timedOut ? 504 : 502);
    throw new OpenRouterRequestError(
      status,
      timedOut
        ? "OpenRouter 分析逾時。"
        : status !== 502
          ? `OpenRouter 回應 HTTP ${status}。`
          : "OpenRouter 目前無法連線。",
      timedOut
        ? "timeout"
        : statusFrom(error) !== null
          ? "http"
          : "connection",
    );
  }

  const responseText = response.choices?.[0]?.message?.content?.trim() ?? "";
  const text = normalizeStructuredJsonOutput(
    responseText,
    request.validateOutput,
  );
  if (!text) {
    throw new OpenRouterRequestError(
      502,
      "OpenRouter 沒有回傳可用內容。",
      "empty_response",
    );
  }
  if (request.validateOutput && !request.validateOutput(text)) {
    request.onInvalidOutput?.(text);
    throw new OpenRouterRequestError(
      502,
      "OpenRouter 回傳內容未通過格式驗證。",
      "invalid_output",
    );
  }

  return { text, provider: "openrouter" };
}

export function resolveOpenRouterModel(): string {
  return OPENROUTER_FREE_MODEL;
}

const GROQ_FREE_MODEL = "openai/gpt-oss-20b";

async function generateGroq(
  apiKey: string,
  request: AiProviderFallbackRequest,
): Promise<AiProviderResult> {
  const timeout =
    request.groqTimeoutMs ??
    request.timeoutMs ??
    DEFAULT_PROVIDER_TIMEOUT_MS;
  const model = request.groqModel ?? GROQ_FREE_MODEL;
  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
    timeout,
    maxRetries: 0,
    fetch: (...args) => globalThis.fetch(...args),
  });

  let response;
  try {
    response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: requestInstructions(request) },
        { role: "user", content: request.input },
      ],
      response_format: { type: "json_object" },
      max_tokens: request.groqMaxOutputTokens ?? request.maxOutputTokens,
      temperature: 0.2,
      stream: false,
    }, request.signal ? { signal: request.signal } : undefined);
  } catch (error) {
    const timedOut = isTimeoutError(error);
    const status = timedOut ? 504 : (statusFrom(error) ?? 502);
    throw new GroqRequestError(
      status,
      timedOut
        ? "Groq 分析逾時。"
        : status !== 502
          ? `Groq 回應 HTTP ${status}。`
          : "Groq 目前無法連線。",
      timedOut
        ? "timeout"
        : statusFrom(error) !== null
          ? "http"
          : "connection",
    );
  }

  const responseText = response.choices?.[0]?.message?.content?.trim() ?? "";
  const text = normalizeStructuredJsonOutput(
    responseText,
    request.validateOutput,
  );
  if (!text) {
    throw new GroqRequestError(
      502,
      "Groq 沒有回傳可用內容。",
      "empty_response",
    );
  }
  if (request.validateOutput && !request.validateOutput(text)) {
    request.onInvalidOutput?.(text);
    throw new GroqRequestError(
      502,
      "Groq 回傳內容未通過格式驗證。",
      "invalid_output",
    );
  }

  return { text, provider: "groq" };
}

async function generateAgnesAi(
  apiKey: string,
  request: AiProviderFallbackRequest,
): Promise<AiProviderResult> {
  const baseUrl = (
    process.env.AGNES_AI_BASE_URL?.trim() ||
    "https://apihub.agnes-ai.com/v1"
  ).replace(/\/+$/, "");
  const model = process.env.AGNES_AI_MODEL?.trim() || "agnes-2.5-flash";

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: requestInstructions(request) },
          { role: "user", content: request.input },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "agnes_ai_response",
            strict: true,
            schema: request.schema,
          },
        },
        max_tokens: request.maxOutputTokens,
        temperature: 0,
        stream: false,
      }),
      signal:
        request.signal ??
        AbortSignal.timeout(
          request.agnesAiTimeoutMs ??
            request.timeoutMs ??
            DEFAULT_PROVIDER_TIMEOUT_MS,
        ),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new AgnesAiRequestError(
      timedOut ? 504 : 502,
      timedOut ? "Agnes AI 分析逾時。" : "Agnes AI 目前無法連線。",
      timedOut ? "timeout" : "connection",
    );
  }

  if (!response.ok) {
    throw new AgnesAiRequestError(
      response.status,
      `Agnes AI 回應 HTTP ${response.status}。`,
      "http",
    );
  }

  let payload: AgnesAiChatResponse;
  try {
    payload = (await response.json()) as AgnesAiChatResponse;
  } catch {
    throw new AgnesAiRequestError(
      502,
      "Agnes AI 回傳無法辨識的資料。",
      "invalid_response",
    );
  }

  const responseText = payload.choices?.[0]?.message?.content?.trim() ?? "";
  if (!responseText) {
    throw new AgnesAiRequestError(
      502,
      "Agnes AI 沒有回傳可用內容。",
      "empty_response",
    );
  }
  const text = normalizeStructuredJsonOutput(
    responseText,
    request.validateOutput,
  );
  if (!text) {
    throw new AgnesAiRequestError(
      502,
      "Agnes AI 沒有回傳可用內容。",
      "empty_response",
    );
  }
  if (request.validateOutput && !request.validateOutput(text)) {
    request.onInvalidOutput?.(text);
    throw new AgnesAiRequestError(
      502,
      "Agnes AI 回傳內容未通過格式驗證。",
      "invalid_output",
    );
  }

  return { text, provider: "agnes_ai" };
}

async function generateOllama(
  apiKey: string,
  request: AiProviderFallbackRequest,
): Promise<AiProviderResult> {
  const model = process.env.OLLAMA_MODEL?.trim() || "gemma4:31b";
  const timeout =
    request.ollamaTimeoutMs ??
    request.timeoutMs ??
    DEFAULT_PROVIDER_TIMEOUT_MS;
  const client = new OpenAI({
    apiKey,
    baseURL: "https://ollama.com/v1",
    timeout,
    maxRetries: 0,
    fetch: (...args) => globalThis.fetch(...args),
  });

  let response;
  try {
    response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: requestInstructions(request) },
        { role: "user", content: request.input },
      ],
      response_format: { type: "json_object" },
      max_tokens: request.maxOutputTokens,
      temperature: 0.2,
      stream: false,
    }, request.signal ? { signal: request.signal } : undefined);
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      ["APIConnectionTimeoutError", "TimeoutError", "AbortError"].includes(
        error.name,
      );
    const status = statusFrom(error) ?? (timedOut ? 504 : 502);
    throw new OllamaRequestError(
      status,
      timedOut
        ? "Ollama 分析逾時。"
        : status !== 502
          ? `Ollama 回應 HTTP ${status}。`
          : "Ollama Cloud 目前無法連線。",
      timedOut
        ? "timeout"
        : statusFrom(error) !== null
          ? "http"
          : "connection",
    );
  }

  const responseText = response.choices?.[0]?.message?.content?.trim() ?? "";
  const text = normalizeStructuredJsonOutput(
    responseText,
    request.validateOutput,
  );
  if (!text) {
    throw new OllamaRequestError(
      502,
      "Ollama 沒有回傳可用內容。",
      "empty_response",
    );
  }
  if (request.validateOutput && !request.validateOutput(text)) {
    request.onInvalidOutput?.(text);
    throw new OllamaRequestError(
      502,
      "Ollama 回傳內容未通過格式驗證。",
      "invalid_output",
    );
  }

  return { text, provider: "ollama" };
}

export function hasAiProviderCredentials(): boolean {
  return [
    process.env.GEMINI_API_KEY,
    process.env.ONEMIN_API_KEY,
    process.env.OPENROUTER_API_KEY,
    process.env.AGNES_AI_API_KEY,
    process.env.OLLAMA_API_KEY,
    process.env.GROQ_API_KEY,
  ].some((value) => Boolean(value?.trim()));
}

export function resolveAiProviderFallbackBudgetMs(
  operation: string,
  requestedBudgetMs = DEFAULT_FALLBACK_BUDGET_MS,
): number {
  const cap = operation === "market_ai_daily_summary"
    ? 24_000
    : operation.startsWith("quant_")
      ? 16_000
      : 12_000;
  return Math.max(1_000, Math.min(requestedBudgetMs, cap));
}

export async function withAiProviderFallback(
  request: AiProviderFallbackRequest,
): Promise<AiProviderResult> {
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();
  const oneMinApiKey = process.env.ONEMIN_API_KEY?.trim();
  const agnesAiApiKey = process.env.AGNES_AI_API_KEY?.trim();
  const ollamaApiKey = process.env.OLLAMA_API_KEY?.trim();
  const openRouterApiKey = process.env.OPENROUTER_API_KEY?.trim();
  const groqApiKey = process.env.GROQ_API_KEY?.trim();

  const providers: Array<{
    provider: AiProviderName;
    label: string;
    apiKey: string | undefined;
    timeoutMs: number;
    run: (attemptRequest: AiProviderFallbackRequest) => Promise<AiProviderResult>;
  }> = [
    {
      provider: "gemini",
      label:
        request.geminiModels && request.geminiModels.length > 1
          ? "Gemini Flash-Lite / Flash"
          : "Gemini Flash-Lite",
      apiKey: geminiApiKey,
      timeoutMs: providerTimeoutMs("gemini", request),
      run: (attemptRequest) =>
        generateGemini(geminiApiKey ?? "", attemptRequest),
    },
    {
      provider: "openrouter",
      label: "OpenRouter",
      apiKey: openRouterApiKey,
      timeoutMs: providerTimeoutMs("openrouter", request),
      run: (attemptRequest) =>
        generateOpenRouter(openRouterApiKey ?? "", attemptRequest),
    },
    {
      provider: "groq",
      label: "Groq Free",
      apiKey: groqApiKey,
      timeoutMs: providerTimeoutMs("groq", request),
      run: (attemptRequest) =>
        generateGroq(groqApiKey ?? "", attemptRequest),
    },
    {
      provider: "agnes_ai",
      label: "Agnes AI",
      apiKey: agnesAiApiKey,
      timeoutMs: providerTimeoutMs("agnes_ai", request),
      run: (attemptRequest) =>
        generateAgnesAi(agnesAiApiKey ?? "", attemptRequest),
    },
    {
      provider: "ollama",
      label: "Ollama",
      apiKey: ollamaApiKey,
      timeoutMs: providerTimeoutMs("ollama", request),
      run: (attemptRequest) =>
        generateOllama(ollamaApiKey ?? "", attemptRequest),
    },
    {
      provider: "1min_ai",
      label: "1min.ai",
      apiKey: oneMinApiKey,
      timeoutMs: providerTimeoutMs("1min_ai", request),
      run: (attemptRequest) =>
        generateOneMinAi(oneMinApiKey ?? "", attemptRequest),
    },
  ];

  const providerByName = new Map(
    providers.map((provider) => [provider.provider, provider]),
  );
  const orderedProviders = request.allowedProviders
    ? [...new Set(request.allowedProviders)].flatMap((providerName) => {
        const provider = providerByName.get(providerName);
        return provider ? [provider] : [];
      })
    : ["groq", "gemini", "openrouter"].flatMap((providerName) => {
        const provider = providerByName.get(providerName as AiProviderName);
        return provider ? [provider] : [];
      });
  const configuredProviders = orderedProviders.filter(
    ({ apiKey, provider }) =>
      apiKey &&
      !(request.operation.startsWith("stock_") && provider === "1min_ai"),
  );
  if (configuredProviders.length === 0) {
    throw new AiProviderFallbackError(
      request.allowedProviders
        ? "尚未設定本次允許的 AI 供應商憑證，AI 分析目前無法使用。"
        : request.operation.startsWith("stock_")
          ? "目前沒有可用於股票分析的 AI 服務。"
          : "尚未設定可用的 AI API 憑證，AI 分析目前無法使用。",
    );
  }

  const failures: Array<{ provider: string; error: unknown }> = [];
  const fallbackBudgetMs = resolveAiProviderFallbackBudgetMs(
    request.operation,
    request.maxFallbackDurationMs,
  );
  let fallbackDeadline: number | null = null;
  for (const [index, provider] of configuredProviders.entries()) {
    const isPrimaryProvider = index === 0;
    if (!isPrimaryProvider && fallbackDeadline === null) {
      fallbackDeadline = Date.now() + fallbackBudgetMs;
    }

    const cooldownKey = `${request.operation}:${provider.provider}`;
    const cooldown = providerCooldowns.get(cooldownKey);
    if (cooldown && cooldown.until > Date.now()) {
      failures.push({
        provider: provider.label,
        error: { status: cooldown.status },
      });
      request.onProviderProgress?.({
        provider: provider.provider,
        state: "skipped",
        message: `${provider.label} 暫時略過，嘗試下一個 AI 服務。`,
      });
      logger.info(
        {
          operation: request.operation,
          requestId: safeRequestId(request.requestId),
          provider: provider.provider,
          status: cooldown.status,
          retryInMs: cooldown.until - Date.now(),
        },
        "Skipping AI provider during cooldown",
      );
      continue;
    }
    if (cooldown) providerCooldowns.delete(cooldownKey);

    const remainingMs = isPrimaryProvider
      ? Number.POSITIVE_INFINITY
      : (fallbackDeadline ?? Date.now()) - Date.now();
    if (remainingMs <= 0) {
      failures.push({
        provider: "AI 備援時間上限",
        error: { status: 504 },
      });
      logger.warn(
        {
          operation: request.operation,
          requestId: safeRequestId(request.requestId),
          fallbackBudgetMs,
        },
        "AI provider fallback time budget exhausted",
      );
      break;
    }

    const boundedTimeoutMs = isPrimaryProvider
      ? provider.timeoutMs
      : Math.max(1, Math.min(provider.timeoutMs, remainingMs));
    const attemptRequest = isPrimaryProvider
      ? request
      : requestWithProviderTimeout(request, boundedTimeoutMs);
    const attemptStartedAt = Date.now();
    request.onProviderProgress?.({
      provider: provider.provider,
      state: "started",
      message: `正在嘗試 ${provider.label}。`,
    });
    logProviderDiagnostic("AI_PROVIDER_ATTEMPT_STARTED", request, provider.provider);
    try {
      const result = await runProviderWithDeadline(
        provider.run,
        attemptRequest,
        boundedTimeoutMs,
        provider.label,
      );
      providerCooldowns.delete(cooldownKey);
      const resultLabel =
        request.operation === "quant_strategy_design"
          ? "策略"
          : request.operation === "quant_research_summary"
            ? "摘要"
            : "分析內容";
      request.onProviderProgress?.({
        provider: provider.provider,
        state: "succeeded",
        message: `${provider.label} 已返回${resultLabel}。`,
      });
      return result;
    } catch (error) {
      const status = statusFrom(error);
      logProviderDiagnostic(
        "AI_PROVIDER_ATTEMPT_FAILED",
        request,
        provider.provider,
        status,
        providerFailureSummary(error, provider.label),
        Date.now() - attemptStartedAt,
      );
      const cooldownMs = cooldownForStatus(status);
      if (cooldownMs > 0) {
        providerCooldowns.set(cooldownKey, {
          until: Date.now() + cooldownMs,
          status: status!,
        });
      }
      failures.push({ provider: provider.label, error });
      request.onProviderProgress?.({
        provider: provider.provider,
        state: "failed",
        message: `${provider.label} 暫時無法使用，正在切換備援服務。`,
      });
      logger.warn(
        {
          operation: request.operation,
          requestId: safeRequestId(request.requestId),
          provider: provider.provider,
          status,
          reason: providerFailureSummary(error, provider.label),
          durationMs: Date.now() - attemptStartedAt,
          fallbackProvider: configuredProviders[index + 1]?.provider ?? null,
        },
        "AI provider failed; trying the next configured provider",
      );
    }
  }

  const onlyRateLimitedProviders =
    failures.length > 0 &&
    failures.every(({ error }) => statusFrom(error) === 429);
  const hasTimedOutProvider = failures.some(
    ({ error }) => statusFrom(error) === 504,
  );
  const status: 429 | 502 | 504 = onlyRateLimitedProviders
    ? 429
    : hasTimedOutProvider
      ? 504
      : 502;
  const message = status === 504
    ? "AI 分析逾時，請稍後重試。"
    : status === 429
      ? "AI 服務目前忙碌，請稍後再試。"
      : "AI 備援服務目前無法完成分析，請稍後再試。";
  console.error(
    JSON.stringify({
      event: "AI_PROVIDER_FALLBACK_EXHAUSTED",
      requestId: safeRequestId(request.requestId),
      operation: request.operation,
      responseStatus: status,
      failures: failures.map(({ provider, error }) => ({
        provider,
        status: statusFrom(error),
      })),
    }),
  );
  throw new AiProviderFallbackError(message, status);
}