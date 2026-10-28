---
name: AI request rate limits
description: Avoid false rate-limit errors when one dashboard uses several AI endpoints.
---

**Rule:** Apply both a per-client overall ceiling and a separate per-operation limit. Include the stock symbol in the operation key when requests are symbol-scoped.

**Why:** A single shared per-IP counter across all AI endpoints caused normal dashboard activity to exhaust the individual-stock analysis allowance.

**How to apply:** When adding or tuning an AI endpoint, preserve an overall abuse ceiling while ensuring unrelated analysis types and symbols do not consume each other's full quota.
