---
name: Vercel runtime log streams
description: Directly retrieving Vercel production runtime logs without adding a Replit connector.
---

When authorized Vercel API access and project identifiers are already available, production runtime logs can be queried directly without connecting Vercel through Replit. Use `GET /v1/projects/{projectId}/deployments/{deploymentId}/runtime-logs?teamId={teamId}`. Confirm the deployment's aliases with `/v2/deployments/{deploymentId}/aliases` before monitoring a production domain. Runtime-log retrieval is a stream; reproduce the failing request while a bounded listener is active. During quiet periods the request may remain pending before response headers, so “request started” does not prove the stream connected. A request row with `responseStatusCode: -1` is not a confirmed final HTTP response. A custom log attached to response finish may also be absent; prefer a sanitized status log immediately before sending each response branch. Application logger records may omit `requestPath`; match a fixed diagnostic marker before filtering by route. Vercel's stream row `message` can contain a JSON-serialized application log, so parse that in memory and emit only approved nested fields; never print or persist the raw line.

**Why:** The runtime endpoint emits streamed request events; an initial or incomplete event can have no final status, and an older deployment can be different from the domain the user is visiting. In this workspace, middleware trace events appeared but the custom finish event did not, and idle stream attempts sometimes remained pending without headers or events.

**How to apply:** Resolve the active production deployment and verify its alias, open a time-bounded log stream only when reproduction is imminent, and trigger the affected route promptly. Distinguish a pending request from a confirmed connection. Emit a sanitized status event immediately before each response branch; check the fixed marker in the stream's `message` before route-path filtering, parse any serialized application JSON in memory, and output only approved fields. If the stream yields no events, avoid repeated provider calls and request a Vercel log timestamp or request ID. Never print or persist raw messages, the API credential, or query strings.

The Replit Vercel connection's `proxyFetch` does not reliably preserve Vercel's `application/stream+json` runtime-log stream; it may yield only a synthetic `source: delimiter` error row with no request path or final status. Do not treat that as proof that the production request emitted no logs.

**Why:** During a live AI-timeout investigation, repeated bounded reads through the connector returned only the delimiter row and hid the underlying streamed entries.

**How to apply:** For Vercel runtime logs, use a raw streaming-capable Vercel API client or Vercel's runtime-log MCP tool. If neither is available, report the log limitation and avoid triggering repeated paid requests.

For provider failures that must remain observable when Pino warnings are filtered by deployment `LOG_LEVEL`, emit fixed console lifecycle markers with only the operation, sanitized request ID, provider identifier, and HTTP status. Mark provider attempt start/failure and exhausted fallback; do not include unrestricted error text.

**Why:** A raised Pino threshold can hide warning-level provider records, while Vercel's request-level 502 row does not identify which provider stage failed.

**How to apply:** Use these markers only for low-volume, high-value diagnosis. Deploy the change before expecting records, then correlate the fixed event names and sanitized request ID; never add prompts, replies, credentials, or vendor error bodies.

Replit's `fetchDeploymentLogs` returned no entries for the Vercel-hosted dashboard, even though the production endpoint was reachable. Treat that callback as separate from Vercel runtime logs.

**Why:** The deployed site is served by Vercel, so an empty Replit deployment-log result does not establish that the Vercel function emitted no logs.

**How to apply:** For this dashboard, use the active Vercel deployment's runtime-log stream; if it does not connect, report the limitation and avoid repeated paid AI requests.

A frontend that reports a signed-in Clerk state while the account API returns 401 is a client/server session mismatch, not by itself an admin-role denial. Vercel environment-variable names and targets do not prove the publishable and secret keys belong to the same Clerk instance. When needed, diagnose only boolean cookie/header presence; never log their values.

**Why:** Server-side session authentication and client-side Clerk state can diverge, while presence-only environment checks cannot validate that two configured keys are paired.

**How to apply:** Separate session failures from role failures first; use sanitized middleware phases and boolean request-header diagnostics before changing roles or credentials.