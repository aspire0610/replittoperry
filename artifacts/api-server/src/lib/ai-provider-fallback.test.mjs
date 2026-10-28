import assert from "node:assert/strict";
import test from "node:test";
import {
  AiProviderFallbackError,
  hasAiProviderCredentials,
  resolveOpenRouterModel,
  resolveAiProviderFallbackBudgetMs,
  withAiProviderFallback,
} from "./ai-provider-fallback.ts";
import {
  QUANT_RESEARCH_AI_PROVIDER_ORDER,
  QUANT_RESEARCH_GEMINI_MODELS,
  QUANT_RESEARCH_GROQ_MODEL,
} from "./quant-research-ai-providers.ts";
import {
  acquireProviderSlot,
  releaseProviderSlot,
  resetProviderCoordinationForTests,
} from "./ai-provider-coordination.ts";

const providerEnvKeys = [
  "ONEMIN_API_KEY",
  "ONEMIN_MODEL",
  "OPENAI_API_KEY",
  "AGNES_AI_API_KEY",
  "AGNES_AI_BASE_URL",
  "OLLAMA_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "GEMINI_API_KEY",
  "NVIDIA_NIM_API_KEY",
  "AI_PROVIDER_COORDINATION_MODE",
];

function saveProviderEnv() {
  return new Map(
    providerEnvKeys.map((key) => [key, process.env[key]]),
  );
}

function configureTestProviders() {
  resetProviderCoordinationForTests();
  for (const key of providerEnvKeys) delete process.env[key];
  process.env.AI_PROVIDER_COORDINATION_MODE = "memory";
  process.env.GEMINI_API_KEY = "test-gemini-key";
  process.env.NVIDIA_NIM_API_KEY = "test-nvidia-nim-key";
  process.env.ONEMIN_API_KEY = "test-onemin-key";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  process.env.AGNES_AI_API_KEY = "test-agnes-key";
  process.env.AGNES_AI_BASE_URL = "https://agnes.test/v1";
  process.env.OLLAMA_API_KEY = "test-ollama-key";
  process.env.GROQ_API_KEY = "test-groq-key";
}

function restoreProviderEnv(saved) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeRequest(operation, overrides = {}) {
  return {
    operation,
    instructions: "Return a JSON object.",
    input: "{}",
    schema: { type: "object" },
    maxOutputTokens: 64,
    timeoutMs: 100,
    maxFallbackDurationMs: 500,
    geminiTimeoutMs: 100,
    oneMinAiTimeoutMs: 100,
    agnesAiTimeoutMs: 100,
    ollamaTimeoutMs: 100,
    openRouterTimeoutMs: 100,
    ...overrides,
  };
}

test("grants market summaries a longer but bounded AI fallback window", () => {
  assert.equal(resolveAiProviderFallbackBudgetMs({
    operation: "market_ai_daily_summary",
    maxFallbackDurationMs: 24_000,
  }), 24_000);
  assert.equal(resolveAiProviderFallbackBudgetMs({
    operation: "market_ai_daily_summary",
    maxFallbackDurationMs: 60_000,
  }), 24_000);
  assert.equal(resolveAiProviderFallbackBudgetMs({
    operation: "ai-fallback-test-generic",
    maxFallbackDurationMs: 60_000,
  }), 12_000);
  assert.equal(resolveAiProviderFallbackBudgetMs({
    operation: "quant_research_summary",
    maxFallbackDurationMs: 60_000,
  }), 16_000);
  assert.equal(resolveAiProviderFallbackBudgetMs({
    operation: "stock_research_agent",
    requestId: "stock-research-agent:scheduled",
    maxFallbackDurationMs: 5_000,
  }), 24_000);
});

function chatResponse(content, status = 200) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function oneMinResponse(content, status = 200) {
  return new Response(
    JSON.stringify({
      aiRecord: {
        status: status < 400 ? "SUCCESS" : "FAILED",
        aiRecordDetail: { resultObject: content ? [content] : [] },
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

async function readFetchRequest(input, init) {
  const request = new Request(input, init);
  return {
    url: request.url,
    body: await request.clone().json(),
    headers: Object.fromEntries(request.headers.entries()),
    signal: request.signal,
  };
}

test("prioritizes free Groq for the shared provider route", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  const calls = [];

  globalThis.fetch = async (input, init) => {
    const request = await readFetchRequest(input, init);
    calls.push({
      url: request.url,
      body: request.body,
    });
    return chatResponse('{"ok":true}');
  };

  try {
    const result = await withAiProviderFallback(
      makeRequest("ai-fallback-test-groq-primary", {
        validateOutput: (text) => text === '{"ok":true}',
      }),
    );

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /api\.groq\.com\/openai\/v1\/chat\/completions$/);
    assert.equal(calls[0].body.model, "openai/gpt-oss-20b");
    assert.equal(calls[0].body.temperature, 0.2);
    assert.equal(result.provider, "groq");
    assert.equal(result.text, '{"ok":true}');
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("shared provider route tries Gemini then OpenRouter after Groq fails", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  const calls = [];

  globalThis.fetch = async (input, init) => {
    const { url: requestUrl, body } = await readFetchRequest(input, init);
    calls.push({ url: requestUrl, body });
    if (requestUrl.includes("api.groq.com")) return chatResponse("", 503);
    if (requestUrl.includes("generativelanguage.googleapis.com")) return chatResponse("", 503);
    if (requestUrl.includes("openrouter.ai")) return chatResponse('{"ok":true}');
    throw new Error(`Unexpected provider URL: ${requestUrl}`);
  };

  try {
    const result = await withAiProviderFallback(makeRequest("ai-fallback-test-order", {
      validateOutput: (text) => text === '{"ok":true}',
    }));
    assert.deepEqual(
      calls.map(({ url }) =>
        url.includes("api.groq.com")
          ? "groq"
          : url.includes("generativelanguage.googleapis.com")
            ? "gemini"
            : "openrouter",
      ),
      ["groq", "gemini", "openrouter"],
    );
    assert.equal(calls[0].body.model, "openai/gpt-oss-20b");
    assert.equal(calls[1].body.model, "gemini-3.5-flash-lite");
    assert.equal(calls[2].body.model, "nvidia/nemotron-3-ultra-550b-a55b:free");
    assert.equal(result.provider, "openrouter");
    assert.equal(result.text, '{"ok":true}');
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("sends JSON requests to NVIDIA NIM using its OpenAI-compatible endpoint", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  for (const key of providerEnvKeys) delete process.env[key];
  process.env.NVIDIA_NIM_API_KEY = "test-nvidia-nim-key";
  let sent;
  globalThis.fetch = async (input, init) => {
    sent = await readFetchRequest(input, init);
    return chatResponse('{"ok":true}');
  };

  try {
    const result = await withAiProviderFallback(makeRequest("ai-fallback-test-nvidia", {
      allowedProviders: ["nvidia_nim"],
      validateOutput: (text) => text === '{"ok":true}',
    }));
    assert.equal(sent.url, "https://integrate.api.nvidia.com/v1/chat/completions");
    assert.equal(sent.body.model, "google/gemma-4-31b-it");
    assert.equal(sent.body.response_format.type, "json_object");
    assert.equal(sent.body.max_tokens, 64);
    assert.equal(sent.body.temperature, 0.2);
    assert.equal(result.provider, "nvidia_nim");
    assert.equal(result.text, '{"ok":true}');
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("quant research uses free Groq first and Gemini as its fast fallback", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  const calls = [];

  globalThis.fetch = async (input, init) => {
    const { url, body } = await readFetchRequest(input, init);
    calls.push({ url, body });
    if (url.includes("generativelanguage.googleapis.com")) {
      if (body.model === "gemini-3.5-flash-lite") return chatResponse('{"ok":true}');
      if (body.model === "gemini-3.8-flash") return chatResponse("", 503);
      throw new Error(`Unexpected Gemini model: ${body.model}`);
    }
    if (url.includes("1min.ai")) return oneMinResponse("", 503);
    if (url.includes("api.groq.com")) return chatResponse("", 503);
    throw new Error(`Unexpected provider URL: ${request.url}`);
  };

  try {
    const result = await withAiProviderFallback(
      makeRequest("quant_strategy_design_flash_fallback", {
        allowedProviders: QUANT_RESEARCH_AI_PROVIDER_ORDER,
        geminiModels: QUANT_RESEARCH_GEMINI_MODELS,
        validateOutput: (text) => text === '{"ok":true}',
      }),
    );

    assert.deepEqual(
      calls.map(({ url }) =>
        url.includes("generativelanguage.googleapis.com")
          ? "gemini"
          : "groq",
      ),
      ["groq", "gemini"],
    );
    assert.equal(calls[0].body.model, QUANT_RESEARCH_GROQ_MODEL);
    assert.equal(calls[1].body.model, "gemini-3.5-flash-lite");
    assert.equal(result.provider, "gemini");
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("quant research reaches Gemini Flash after Groq and Flash-Lite fail", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  const calls = [];

  globalThis.fetch = async (input, init) => {
    const { url, body } = await readFetchRequest(input, init);
    calls.push({ url, body });
    if (url.includes("api.groq.com")) return chatResponse("", 503);
    if (!url.includes("generativelanguage.googleapis.com")) throw new Error(`Unexpected backup provider call: ${url}`);
    return body.model === "gemini-3.5-flash-lite"
      ? chatResponse("", 503)
      : chatResponse('{"ok":true}');
  };

  try {
    const result = await withAiProviderFallback(
      makeRequest("quant_strategy_design", {
        allowedProviders: QUANT_RESEARCH_AI_PROVIDER_ORDER,
        geminiModels: QUANT_RESEARCH_GEMINI_MODELS,
        validateOutput: (text) => text === '{"ok":true}',
      }),
    );

    assert.deepEqual(
      calls.map(({ body }) => body.model),
      [QUANT_RESEARCH_GROQ_MODEL, "gemini-3.5-flash-lite", "gemini-3.8-flash"],
    );
    assert.equal(result.provider, "gemini");
    assert.equal(result.text, '{"ok":true}');
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("quant research completes on Groq Free without trying a slower backup", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  const calls = [];

  globalThis.fetch = async (input, init) => {
    const { url, body } = await readFetchRequest(input, init);
    calls.push({ url, body });
    if (url.includes("api.groq.com")) return chatResponse('{"ok":true}');
    throw new Error(`Unexpected backup provider call: ${url}`);
  };

  try {
    const result = await withAiProviderFallback(
      makeRequest("quant_strategy_design_groq_success", {
        allowedProviders: QUANT_RESEARCH_AI_PROVIDER_ORDER,
        geminiModels: QUANT_RESEARCH_GEMINI_MODELS,
        groqModel: QUANT_RESEARCH_GROQ_MODEL,
        groqMaxOutputTokens: 512,
        validateOutput: (text) => text === '{"ok":true}',
      }),
    );

    assert.deepEqual(calls.map(({ body }) => body.model), [QUANT_RESEARCH_GROQ_MODEL]);
    assert.equal(calls.at(-1).body.model, QUANT_RESEARCH_GROQ_MODEL);
    assert.equal(calls.at(-1).body.max_tokens, 512);
    assert.equal(
      calls.at(-1).url,
      "https://api.groq.com/openai/v1/chat/completions",
    );
    assert.equal(result.provider, "groq");
    assert.equal(result.text, '{"ok":true}');
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("keeps 1min.ai available for non-stock features that explicitly use it", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const request = await readFetchRequest(input, init);
    calls.push(request);
    if (request.url.includes("1min.ai")) return oneMinResponse('{"ok":true}');
    throw new Error(`Unexpected provider URL: ${url}`);
  };

  try {
    const result = await withAiProviderFallback(
      makeRequest("assistant_chat", {
        allowedProviders: ["1min_ai", "gemini", "nvidia_nim"],
        validateOutput: (text) => text === '{"ok":true}',
      }),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.1min.ai/api/chat-with-ai");
    assert.equal(calls[0].headers["api-key"], "test-onemin-key");
    assert.equal(calls[0].body.model, "qwen3.7-flash");
    assert.match(calls[0].body.promptObject.prompt, /Return a JSON object/);
    assert.equal(result.provider, "1min_ai");
    assert.equal(result.text, '{"ok":true}');
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("pins OpenRouter to free Nemotron 3 Ultra instead of an environment override", () => {
  const savedEnv = saveProviderEnv();
  process.env.OPENROUTER_MODEL = "paid-model-must-not-be-used";

  try {
    assert.equal(
      resolveOpenRouterModel(),
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    );
  } finally {
    restoreProviderEnv(savedEnv);
  }
});

test("removes personal position data before sending requests to OpenRouter Free", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push(await readFetchRequest(input, init));
    return chatResponse('{"ok":true}');
  };

  try {
    const result = await withAiProviderFallback(
      makeRequest("ai-fallback-test-openrouter-position-redaction", {
        allowedProviders: ["openrouter"],
        input: JSON.stringify({
          symbol: "2330",
          marketPrice: 777,
          shares: 1234,
          currentShares: 2345,
          averageCost: 876.5,
          userQuestion:
            "我目前持有 1,234 股，平均成本 876.5 元，請問要不要續抱？",
          conversationHistory: [
            { role: "user", content: "我有 3 張 0050，成本 800 元。" },
            {
              role: "user",
              content: "I bought 88 shares at an average cost of $5.25.",
            },
          ],
        }),
        validateOutput: (text) => text === '{"ok":true}',
      }),
    );

    assert.equal(result.provider, "openrouter");
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].body.model,
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    );
    const sentInput = JSON.parse(calls[0].body.messages[1].content);
    assert.equal(sentInput.symbol, "2330");
    assert.equal(sentInput.marketPrice, 777);
    assert.equal(sentInput.shares, undefined);
    assert.equal(sentInput.currentShares, undefined);
    assert.equal(sentInput.averageCost, undefined);
    assert.match(sentInput.userQuestion, /個人持倉資訊已移除/u);
    assert.match(
      sentInput.conversationHistory[0].content,
      /個人持倉資訊已移除/u,
    );
    assert.match(
      sentInput.conversationHistory[1].content,
      /個人持倉資訊已移除/u,
    );
    assert.doesNotMatch(
      JSON.stringify(calls[0].body),
      /1,234|2,345|876\.5|3 張|800 元|88 shares|5\.25/u,
    );
    assert.match(calls[0].body.messages[0].content, /不要推測持股數或成本/u);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("a legacy direct OpenAI credential does not enable AI routing", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  for (const key of providerEnvKeys) delete process.env[key];
  process.env.OPENAI_API_KEY = "disabled-openai-key";
  let fetchAttempts = 0;
  globalThis.fetch = async () => {
    fetchAttempts += 1;
    throw new Error("No provider request should be made");
  };

  try {
    assert.equal(hasAiProviderCredentials(), false);
    await assert.rejects(
      withAiProviderFallback(
        makeRequest("ai-fallback-test-inactive-providers"),
      ),
      (error) => error instanceof AiProviderFallbackError,
    );
    assert.equal(fetchAttempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("Gemini credentials alone enable AI routing", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  for (const key of providerEnvKeys) delete process.env[key];
  process.env.GEMINI_API_KEY = "test-gemini-key";
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const request = await readFetchRequest(input, init);
    calls.push(request.url);
    return chatResponse('{"ok":true}');
  };

  try {
    assert.equal(hasAiProviderCredentials(), true);
    const result = await withAiProviderFallback(makeRequest("ai-fallback-test-gemini-only"));
    assert.equal(result.provider, "gemini");
    assert.deepEqual(calls, [
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("classifies nested fetch timeout errors as Gemini timeouts", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  for (const key of providerEnvKeys) delete process.env[key];
  process.env.GEMINI_API_KEY = "test-gemini-key";
  globalThis.fetch = async () => {
    const cause = Object.assign(new Error("Timed out"), {
      name: "HeadersTimeoutError",
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    throw new TypeError("fetch failed", { cause });
  };

  try {
    await assert.rejects(
      withAiProviderFallback(
        makeRequest("ai-fallback-test-gemini-nested-timeout", {
          allowedProviders: ["gemini"],
        }),
      ),
      (error) =>
        error instanceof AiProviderFallbackError && error.status === 504,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("maps an upstream 504 to the timeout response", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  delete process.env.AGNES_AI_API_KEY;

  globalThis.fetch = async () => chatResponse("", 504);

  try {
    await assert.rejects(
      withAiProviderFallback(makeRequest("ai-fallback-test-timeout", {
        maxFallbackDurationMs: 200,
      })),
      (error) =>
        error instanceof AiProviderFallbackError && error.status === 504,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("bounds a provider whose response body never finishes and tries the next provider", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  let openRouterSignal;
  const progress = [];
  globalThis.fetch = async (input, init) => {
    const request = await readFetchRequest(input, init);
    if (request.url.includes("openrouter.ai")) {
      openRouterSignal =
        init?.signal ?? (input instanceof Request ? input.signal : request.signal);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('{"choices":[{"message":{"content":"'),
            );
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (request.url.includes("agnes.test")) return chatResponse('{"ok":true}');
    throw new Error(`Unexpected provider URL: ${request.url}`);
  };

  try {
    const startedAt = Date.now();
    const result = await withAiProviderFallback(
      makeRequest("ai-fallback-test-stalled-body", {
        allowedProviders: ["openrouter", "agnes_ai"],
        openRouterTimeoutMs: 100,
        agnesAiTimeoutMs: 200,
        maxFallbackDurationMs: 300,
        onProviderProgress: (event) => progress.push(event),
      }),
    );

    assert.equal(result.provider, "agnes_ai");
    assert.ok(Date.now() - startedAt < 1_500);
    assert.equal(openRouterSignal?.aborted, true);
    assert.deepEqual(
      progress.map(({ provider, state }) => [provider, state]),
      [
        ["openrouter", "started"],
        ["openrouter", "failed"],
        ["agnes_ai", "started"],
        ["agnes_ai", "succeeded"],
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("reports mixed provider failures and respects per-provider cooldowns", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  const attempts = {
    gemini: 0,
    nvidiaNim: 0,
    oneMin: 0,
    openrouter: 0,
    groq: 0,
    agnes: 0,
    ollama: 0,
  };
  globalThis.fetch = async (input, init) => {
    const { url } = await readFetchRequest(input, init);
    if (url.includes("generativelanguage.googleapis.com")) {
      attempts.gemini += 1;
      return chatResponse("", 429);
    }
    if (url.includes("integrate.api.nvidia.com")) {
      attempts.nvidiaNim += 1;
      return chatResponse("", 429);
    }
    if (url.includes("1min.ai")) {
      attempts.oneMin += 1;
      return oneMinResponse("", 429);
    }
    if (url.includes("openrouter.ai")) {
      attempts.openrouter += 1;
      return chatResponse("", 429);
    }
    if (url.includes("api.groq.com")) {
      attempts.groq += 1;
      return chatResponse("", attempts.groq === 1 ? 503 : 429);
    }
    if (url.includes("agnes.test")) {
      attempts.agnes += 1;
      return chatResponse("", 503);
    }
    attempts.ollama += 1;
    return chatResponse("", 502);
  };

  try {
    await assert.rejects(
      withAiProviderFallback(makeRequest("ai-fallback-test-cooldown")),
      (error) =>
        error instanceof AiProviderFallbackError && error.status === 502,
    );

    assert.deepEqual(attempts, {
      gemini: 1,
      nvidiaNim: 0,
      oneMin: 0,
      openrouter: 1,
      groq: 1,
      agnes: 0,
      ollama: 0,
    });

    await assert.rejects(
      withAiProviderFallback(makeRequest("ai-fallback-test-cooldown")),
      (error) =>
        error instanceof AiProviderFallbackError && error.status === 502,
    );
    assert.deepEqual(attempts, {
      gemini: 1,
      nvidiaNim: 0,
      oneMin: 0,
      openrouter: 1,
      groq: 1,
      agnes: 0,
      ollama: 0,
    });

    delete process.env.AGNES_AI_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    resetProviderCoordinationForTests();
    await assert.rejects(
      withAiProviderFallback(makeRequest("ai-fallback-test-only-rate-limit")),
      (error) =>
        error instanceof AiProviderFallbackError && error.status === 429,
    );
    assert.equal(attempts.gemini, 2);
    assert.equal(attempts.openrouter, 2);
    assert.equal(attempts.groq, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("shares provider cooldown across different AI operations", async () => {
  const savedEnv = saveProviderEnv();
  const originalFetch = globalThis.fetch;
  configureTestProviders();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return chatResponse("", 429);
  };

  try {
    await assert.rejects(
      withAiProviderFallback(
        makeRequest("ai-fallback-stock-test", { allowedProviders: ["groq"] }),
      ),
      (error) =>
        error instanceof AiProviderFallbackError && error.status === 429,
    );
    await assert.rejects(
      withAiProviderFallback(
        makeRequest("ai-fallback-chat-test", { allowedProviders: ["groq"] }),
      ),
      (error) =>
        error instanceof AiProviderFallbackError && error.status === 429,
    );
    assert.equal(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreProviderEnv(savedEnv);
  }
});

test("caps simultaneous requests to the same provider", async () => {
  configureTestProviders();
  const first = await acquireProviderSlot("groq", 2, 30_000);
  const second = await acquireProviderSlot("groq", 2, 30_000);
  const third = await acquireProviderSlot("groq", 2, 30_000);
  assert.equal(first.state, "acquired");
  assert.equal(second.state, "acquired");
  assert.deepEqual(third, { state: "busy" });
  if (first.state === "acquired") await releaseProviderSlot(first.lease);
  const afterRelease = await acquireProviderSlot("groq", 2, 30_000);
  assert.equal(afterRelease.state, "acquired");
  if (second.state === "acquired") await releaseProviderSlot(second.lease);
  if (afterRelease.state === "acquired") {
    await releaseProviderSlot(afterRelease.lease);
  }
});
