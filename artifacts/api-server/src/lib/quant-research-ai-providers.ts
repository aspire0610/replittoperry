import type { AiProviderName } from "./ai-provider-fallback.js";

export const QUANT_RESEARCH_GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
] as const;

export const QUANT_RESEARCH_GROQ_MODEL = "openai/gpt-oss-20b";

export const QUANT_RESEARCH_AI_PROVIDER_ORDER = [
  "gemini",
  "1min_ai",
  "groq",
  "agnes_ai",
  "ollama",
] as const satisfies readonly AiProviderName[];
