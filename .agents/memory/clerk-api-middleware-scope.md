---
name: Clerk API middleware scope
description: Express middleware placement boundaries for the dashboard's Clerk-protected account and admin APIs.
---

Mount Clerk middleware at the Express app layer before routers, covering both `/api/account` and `/api/admin`. Do not limit it to the account prefix or run it on every public API route.

**Why:** Account/profile endpoints and administrator endpoints use separate URL prefixes, while market data endpoints remain public. Correctly scoped app-level middleware serves both auth paths without changing public API behavior.

**How to apply:** When changing API routing, check each protected route's final URL prefix and keep the existing account-access and administrator authorization checks unchanged.

Public cron endpoints must also be mounted before the account router. That router applies `requireAccountAccess` at router level, so unmatched cron paths can be intercepted before a later public router sees them.

**Why:** A new cron route mounted after the account router returned the account-service error instead of reaching its own bearer-secret check.

**How to apply:** In the root API router, place unauthenticated but independently secret-protected scheduled routes before `accountRouter`; keep their own authentication check on the route.