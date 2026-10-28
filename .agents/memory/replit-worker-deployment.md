---
name: External worker and scan DB boundaries
description: Hosting boundaries and database identity checks for persistent LINE/Fugle and market-scan workers.
---

Keep the Vercel deployment as the primary dashboard and account API. The user chose an external always-on host for the persistent LINE/Fugle Worker and does not want to publish this workspace as a Replit VM. The relay must be reachable publicly from Vercel, while quote reads remain HMAC-protected.

**Why:** The user explicitly preferred not to run a Replit VM and chose another always-on host while keeping Vercel as the production dashboard/API.

**How to apply:** Preserve the Vercel production host and its SSO/Clerk controls. Set `LINE_WORKER_URL` in Vercel to the external worker's public HTTPS base URL, and keep identical Fugle keys in both environments. Do not start a second Fugle stock stream in the Vercel API when the Worker relay is configured.

The user reports that the existing worker operated without the additional Railway variables previously suggested. Do not infer that they must be added from an empty variable-name listing alone; verify the actual runtime and failure logs first.

**Why:** The observed market-scan failure was caused by an unavailable TWSE endpoint and FinMind entitlement rejection, while the Replit worker itself started and processed a job.

**How to apply:** Distinguish Replit workflow logs from Railway production logs, and identify the failing provider or runtime before asking the user to change secrets or deployment configuration.

The user confirms AI scanning previously worked. The Replit market-scan workflow can be healthy while connected to a different database than Vercel production; a successful scan in the Replit database does not prove the production queue is being processed. A failed Railway LINE/Fugle deployment alone does not establish the scan worker's state.

**Why:** The production Neon database had a queued scan while the Replit worker's configured database contained completed scans.

**How to apply:** Compare sanitized job state from the worker's own database with production Neon before changing Railway, worker hosting, or secrets.

In Replit preview, the API and market-scan worker must use the same development `DATABASE_URL`. The production worker command intentionally overrides it with `MARKET_SCAN_DATABASE_URL`; using that production command in preview leaves development scan jobs unclaimed.

**Why:** A preview scan remained at 3% because the API enqueued it in the development database while the worker watched the production database.

**How to apply:** Match the worker command to the API environment: use the default `market-scan-worker` command in development and the production override only when processing the production queue.
