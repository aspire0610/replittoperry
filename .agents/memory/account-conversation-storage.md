---
name: Account conversation storage
description: Production database constraint for account-synced stock assistant history.
---

Vercel production uses a dedicated Neon project, `tw-stock-dashboard-prod` (AWS US East 1, `production` branch, `neondb`), separate from Replit's development database. The user configured production `DATABASE_URL` manually in Vercel; the reconnected Vercel integration can trigger deployments when requested.

**Why:** Replit preview and Vercel production have independent database environments; keeping them separate avoids mixing development and production conversation data. The Vercel API connection was restored after the user requested an API-triggered production deployment.

**How to apply:** Keep storage imports lazy and return a clear 503 if `DATABASE_URL` is absent. Keep the Neon pooled URL (hostname includes `-pooler`) in Vercel Production and never expose its value. Use the Vercel integration for deployments only when requested. Do not consider production sync verified until authenticated save/load/delete testing succeeds.