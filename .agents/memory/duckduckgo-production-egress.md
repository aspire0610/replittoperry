---
name: DuckDuckGo production egress
description: Observed server-side DuckDuckGo access restrictions affecting Vercel production search.
---

On 2026-10-12, the fixed-query admin diagnostic in Vercel production received HTTP 403 from DuckDuckGo's HTML search endpoint. During follow-up checks, other official DuckDuckGo HTML/Lite endpoints returned HTTP 202 challenge responses from the workspace network. Earlier preview checks had succeeded, so availability is environment- and time-dependent; the production failure is not evidence of a parsing bug.

**Why:** The provider's production refusal must not be hidden by treating it as an empty result. On 2026-10-13, after declining self-hosting, the user selected public Google News RSS as the free LINE search compromise.

**How to apply:** Keep search fail-closed and surface only safe status metadata. Do not route queries through an unrelated proxy or rotate endpoints or identities to evade access controls. Public RSS has no unlimited-use guarantee; do not describe it as unlimited.
