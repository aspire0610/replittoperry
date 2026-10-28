---
name: Vercel API documentation access
description: Fallback for checking official Vercel API contracts when Replit web callbacks are unavailable.
---

When Replit's `webSearch` or `webFetch` callbacks return 402 while researching Vercel's REST API, direct shell `curl` can still retrieve Vercel's public REST reference and OpenAPI schema.

**Why:** Both callbacks returned 402 during an authorized production release, while direct access to the official Vercel docs and OpenAPI schema worked.

**How to apply:** Confirm API request and response shapes from Vercel's official docs or OpenAPI before a release; never print credentials or include them in saved artifacts.