export type WebSearchFailureKind =
  | "configuration_error"
  | "http_error"
  | "timeout"
  | "network_error";

export class WebSearchProviderConfigurationError extends Error {
  constructor() {
    super("The selected web search provider is not configured.");
    this.name = "WebSearchProviderConfigurationError";
  }
}
