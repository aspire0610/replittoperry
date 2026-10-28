import { AiProviderFallbackError } from "./ai-provider-fallback.js";

export function getAiProviderFailure(
  error: unknown,
): { status: 429 | 502 | 504; message: string } | null {
  if (!(error instanceof AiProviderFallbackError)) return null;
  return { status: error.status, message: error.message };
}
