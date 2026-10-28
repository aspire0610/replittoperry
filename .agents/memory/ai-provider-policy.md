---
name: AI provider policy
description: The current provider scope for AI features in the Taiwan stock dashboard.
---

For interactive AI across the dashboard, use Groq Free (`openai/gpt-oss-20b`) first, Gemini Flash-Lite (`gemini-3.5-flash-lite`) second, and the pinned OpenRouter Free model third. Keep short per-provider and overall fallback deadlines. Do not silently fall through to paid providers on interactive requests. OpenRouter requests must continue removing personal position details. Quant research uses Groq Free then Gemini Flash-Lite/Flash; keep OpenRouter and metered 1min.ai out of new quant runs. Keep stock facts grounded in official exchange and company data; model knowledge is not a source of truth.

**Why:** On 2026-10-15, the user said AI responses across the system were too slow and asked to try faster free models. The previous Gemini-first and long fallback paths were delaying answers. Earlier, the user also rejected high 1min.ai usage; OpenRouter Free remains acceptable only with personal holding details removed.

**How to apply:** Keep interactive routing and tests aligned with Groq Free → Gemini Flash-Lite → OpenRouter Free; enforce provider deadlines and validate structured output without weakening safety checks. Use only the approved free model set unless the user explicitly approves paid fallback. Preserve OpenRouter redaction and keep quant inputs restricted to supplied research data. Keep official market data authoritative and search snippets labeled as unverified.

Do not add Perplexity's metered Agent/Search API without renewed approval. Use Ollama Cloud at `https://ollama.com/v1` with `OLLAMA_API_KEY`, defaulting to `gemma4:31b` unless `OLLAMA_MODEL` is set.

Require Agnes AI to use strict JSON Schema responses, normalize fenced or prefaced output, and validate it with the consuming parser before accepting it.

**Why:** A live stock assessment received an Agnes response that failed validation; strict schema mode and normalization made the fallback return a usable structured result.

**How to apply:** Preserve strict structured output and parser validation when changing the Agnes integration; verify with a real stock assessment, not only a trivial JSON prompt.

Use workload-specific bounded timeouts for structured requests. Prioritize faster fallback services for interactive stock answers while leaving enough time for valid structured output. Validate each provider response with the consuming parser before treating it as a success.

**Why:** The user wants both successful answers and shorter waits when multiple providers are unavailable.

**How to apply:** Bound the primary and fallback paths, allocate time across eligible providers, and keep schema validation at the provider boundary. Retest live inference when changing model timeouts.

Per-request fallback duration can be clamped by a separate operation-level cap. Update and test the effective cap together with the request's timeout settings.

**Why:** On 2026-10-28, the production pre-market summary requested a 35-second fallback window, but the generic cap restricted it to 12 seconds and the route returned a timeout.

**How to apply:** Test the effective budget for each scheduled AI operation, not just the `maxFallbackDurationMs` passed by its caller.

For the interactive position assistant, give the configured free and existing fallback models enough total time to run sequentially, while staying within the browser request deadline. Do not add a provider with unverified costs solely to increase the fallback count.

**Why:** The user reported frequent timeouts and asked to try several AI services that offer free models.

**How to apply:** Keep OpenRouter Free and Groq Free in the position-assistant fallback path, followed by already-configured backups; preserve hard per-provider timeouts and the overall client deadline.

For OpenRouter Free, remove personal share counts, cost basis, position fields, and holdings-bearing text/history before dispatch. Keep other providers' request input unchanged.

**Why:** The user approved the free endpoint on the condition that personal holding details are not sent to it.

**How to apply:** Apply redaction only on the OpenRouter Free route, replace removed text with a generic notice, and tell the model to report insufficient data rather than infer holdings. Test the outgoing request body and retain the financial response validators.

For LINE web search, use the user's selected public Google News RSS source as a free compromise when no self-hosted search service is available. This is not a supported unlimited API and may be throttled or changed. Agnes AI may summarize supplied results, but its documented API is not a source-producing web search service.

**Why:** The user declined self-hosting and selected public news RSS after DuckDuckGo returned HTTP 403 in Vercel production. They want a free source, while accepting that public RSS cannot guarantee unlimited use. Search diagnostics must never store or display the conversation question, reply, or keys.

**How to apply:** Keep search retrieval separate from answer-generation providers. Do not send paid search requests without renewed approval. If public RSS is empty or unavailable, report that no sources could be verified rather than inventing a catalyst. Admin diagnostics may use only a fixed test query, must not invoke an AI model, and may return/log only provider, outcome, result count, HTTP status, safe failure category, and timestamp—never the query or result content.

For website individual-stock movement-cause questions, try DuckDuckGo first and use Google News RSS only when DuckDuckGo fails or returns no results. Do not add a paid search fallback.

**Why:** A production 6223 question returned official quote data but no causal reporting; the site assistant previously had no second search source for this case.

**How to apply:** Keep the fallback limited to stock movement-reason questions, retain official exchange data as authoritative, label news snippets as incomplete search evidence, and say when neither source verifies a cause. Public RSS is not guaranteed and may be throttled.

OpenRouter is pinned to free Nemotron Ultra; valid JSON alone does not establish that a stock-assistant answer passes its action, language, and evidence checks. Keep the UI question aligned with the response schema: the action belongs in the typed position-action field, while the answer is only its rationale because the server composes the action summary. Treat `insufficient` as a valid conservative action when user-specific data is missing, remove harmless headings, and retain direct buy/sell-command and cited-fact validation.

**Why:** A live assistant-schema test against changing OpenRouter Free model selections can produce structured responses the consumer rejects, including incompatible actions, JSON-format failures, and headings requested by the UI but absent from the schema. Aligning the position question with the structured fields allows the fallback to return valid answers.

**How to apply:** Review the UI question, provider schema, consumer validator, and server-composed summary as one contract. Test the complete consumer validator, not only JSON parsing. Do not log raw model output or relax financial action and evidence checks to make a response pass.

Set browser action deadlines for the complete request path, including data retrieval, model discovery, and all provider fallbacks—not just one provider's timeout.

**Why:** A mobile client stopped waiting at 70 seconds while the buy-price endpoint needed about 72 seconds to finish, so a backend error was shown as a generic network failure.

**How to apply:** Keep client action deadlines longer than the expected end-to-end fallback path and show a clear pending state while the request is running.

Groq GPT-OSS may return HTTP 400 with `json_validate_failed` when a short structured summary is limited to 180 output tokens. A Groq-specific 512-token allocation succeeds without increasing other providers' output budget.

**Why:** A live Groq probe reproduced the 400 at 180 tokens and passed with the larger Groq-only allocation.

**How to apply:** Keep Groq's output-token override for compact quant summaries; validate its JSON response through the existing consumer parser.

An OpenAI-compatible provider can return response headers while its non-streaming JSON body remains incomplete; the SDK timeout did not reliably bound the full response-parsing promise in a quant-research request. Enforce a hard deadline around each complete provider attempt and abort that attempt's signal.

**Why:** On 2026-10-07, the Ollama fallback remained pending for several minutes after its attempt started; a test with an unfinished response body reproduced the unbounded wait.

**How to apply:** Keep the provider-attempt deadline around `provider.run()` itself, including body parsing and validation, and test with a response stream that never closes.