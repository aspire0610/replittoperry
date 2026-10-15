import type { AiProviderName } from "./ai-provider-fallback.js";

export const QUANT_RESEARCH_GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
] as const;

export const QUANT_RESEARCH_GROQ_MODEL = "openai/gpt-oss-20b";

export const QUANT_RESEARCH_AI_PROVIDER_ORDER = [
  "groq",
  "gemini",
] as const satisfies readonly AiProviderName[];
