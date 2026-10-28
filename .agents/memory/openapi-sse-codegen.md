---
name: OpenAPI SSE codegen
description: Compatibility guidance for documenting endpoints that negotiate server-sent events with generated API clients.
---

Keep the generated OpenAPI response schema JSON-only when the same route serves SSE based on the `Accept` header; document the SSE mode in the response description instead of adding a second media type if Orval validation fails.

**Why:** Orval's workspace validator rejected the mixed JSON and `text/event-stream` response content shape, so codegen could not run until SSE was described in prose.

**How to apply:** When an endpoint preserves a normal JSON response but supports opt-in SSE, keep the JSON `$ref` as the generated contract, mention the `Accept: text/event-stream` behavior in the response description, and re-run API codegen.
