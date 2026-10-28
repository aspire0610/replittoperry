---
name: LINE summary scheduling
description: Hosting, credentials, and deployment policy for LINE premarket and closing summaries.
---

Use GitHub Actions Free for scheduled calls to the existing Vercel summary routes, while keeping Vercel SSO enabled. Vercel Hobby Cron has only hourly scheduling precision (up to 59 minutes late), so do not use it for market-time delivery. Keep the 15:00 closing trigger, a ten-minute retry, and later retries for official-close readiness; per-user sent-date markers prevent duplicate pushes. The LINE closing route should require a same-day official index close for the AI summary, but must not block delivery on full-market stock quotes; include watchlist quotes only when their official data is current. GitHub schedule events may be delayed or missed, so retries improve delivery odds but cannot guarantee exact-minute execution. The workflow must be present on GitHub's default branch and its required Actions secrets must exist. The Vercel production branch may differ from GitHub's default branch; update the correct branch for each system. Remove native Vercel cron entries when switching schedulers to avoid duplicate invocations. Store credentials only in GitHub Actions secrets and send them as request headers, never in source code or URLs.

**Why:** The user does not want Railway because it requires payment and wants the production SSO protection preserved. On 2026-10-15, the scheduled 15:00 and 15:10 GitHub Actions runs were absent; the 15:13 request skipped because TWSE/TPEx stock quotes lagged the index summary shown on the homepage. Vercel production used `vercel-deploy`, while the scheduler lived on `main`. Also on 2026-10-15, GitHub recorded the 00:30 and 00:45 UTC premarket runs at 04:58 and 05:16 UTC (12:58 and 13:16 Taipei), both with sent=0 and skipped=2; the 08:50 Taipei manual dispatch sent=2.

**How to apply:** Keep future changes limited to the scheduler and its required production route; do not resume broad Replit GitHub sync or push unrelated workspace history. Do not use narrow runner-local time cutoffs that exit before calling the route; GitHub can delay scheduled runs, and route-level date deduplication should prevent duplicate pushes. Preserve retries. Log the selected route and distinguish no-subscription, unlinked, and already-sent skips. Verify the remote default branch, Vercel production branch, Actions workflow presence, required secret names, and real send counts before claiming delivery is reliable. The user rejects paid Railway hosting; keep the schedule on free GitHub Actions unless they explicitly change that constraint. Explain that GitHub's free scheduled runs cannot guarantee exact-minute delivery.

The app is published on Vercel, not Replit. The user chose a separate external scheduler for backup dispatch. Prefer having it trigger the existing GitHub `workflow_dispatch` closing input instead of calling Vercel directly; this keeps route credentials in GitHub and reuses workflow concurrency.

**Why:** The Replit Publishing panel has no published app for this project, and directly calling the protected Vercel route would require copying its secrets to a third party and could bypass the workflow's concurrency controls.

**How to apply:** Choose an external scheduler that supports POST requests, custom headers, and JSON bodies. Store a repository-scoped GitHub token with Actions:write only in that scheduler, never in source code or chat. Configure the job outside Replit Publishing and do not change the Vercel app's production target.

The production LINE scheduler and its repository-scoped Actions secrets live in `aspire0610/replittoperry`; do not assume another connected repository is the target. Before adding or dispatching a workflow, verify that the workflow and both secret names are in the same repository. An empty secret list only applies to the repository queried.

**Why:** The connected GitHub account contains multiple repositories. The user had configured the correct secrets in `replittoperry`, while a separate `stock_smart` repo had none.

**How to apply:** Confirm the repository identity from the user's context, then check its default-branch workflow, secret names, and run records together. Never infer that secrets are globally shared across repositories.

Before declaring a Vercel summary fix complete, compare the production branch's prompt, output schema, and formatter with the default branch. On 2026-10-28, production still used a single 90-character summary while the default branch had a structured multi-section format, so a successful push delivered valid but visibly incomplete content.

**Why:** Updating only the timeout logic did not bring the production branch's summary format up to date.

**How to apply:** When a LINE summary's shape changes, verify the effective formatter in the deployed Vercel branch and test its rendered message, not only the AI response or route status.

Vercel production has returned malformed JSON from both exchange OpenAPI endpoints while the exchanges' official MI_INDEX and TPEx dailyQuotes reports were available. Keep same-date official fallbacks for both exchanges and require valid coverage from each; missing TPEx change values must remain marked unavailable rather than inferred.

**Why:** Production LINE closing-summary calls failed before sending even though the current-day official reports could be fetched elsewhere.

**How to apply:** If Vercel's OpenAPI response parsing fails, fall back only to TWSE MI_INDEX and TPEx dailyQuotes with retry-aware official JSON fetching; do not use prior-day or third-party prices.
