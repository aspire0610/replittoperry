---
name: Account hosting policy
description: User-account and watchlist persistence decisions for the stock dashboard.
---

For the stock dashboard, access is invite-only and production stays on Vercel. Use the user's external Clerk instance; store per-account watchlists in Clerk private metadata. Do not switch watchlists to PostgreSQL or Replit-managed services.

**Why:** The user chose external Clerk and private metadata for account watchlists, and asked to keep production on Vercel.

**How to apply:** Keep browser-local watchlists separate from account watchlists unless the user explicitly requests an import. Never auto-promote the first public registrant, and ask before publishing.

Keep Vercel SSO protection enabled in production in addition to Clerk's invite-only access and account-role checks.

**Why:** The user explicitly requested that Vercel protection be turned back on.

**How to apply:** Preserve both protection layers; Vercel SSO is not a substitute for the dashboard's Clerk authorization checks.

Signed-out visitors should see only Taiwan's public index and TAIFEX figures. Keep both U.S. indicators (TSM ADR and SOX), individual-stock details, the watchlist, and portfolio tools hidden until sign-in. Preserve the complete dashboard for signed-in users.

**Why:** The user explicitly requested a Taiwan-market-only guest view and asked that U.S. indicators appear only after sign-in, while preserving the existing signed-in dashboard.

**How to apply:** Gate unauthenticated UI, navigation, and stock-data queries using the existing Clerk state. Place U.S. indicators only in the signed-in dashboard. Do not change Clerk configuration or account roles for this behavior.

For explicitly authorized direct-source Vercel releases, use the latest successful production deployment to preserve build settings, but upload the current workspace source to the linked project. A redeploy using only `deploymentId` rebuilds old source; Vercel also inherits that deployment's environment-variable snapshot, which may omit project secrets added afterward. When new project variables must be picked up, create a project-scoped production deployment with current source and matching build settings instead of using `deploymentId`. If the Vercel CLI is blocked by the Replit package firewall, do not bypass it; use the Vercel deployment API and respect `.vercelignore`. Verify production aliases separately because a public landing-page response does not establish protected API access.

**Why:** Vercel currently reports this project as Git-linked with production branch `vercel-deploy`, but a recent redeploy from stale source lacked a frontend component present in the workspace. Direct-source releases ensure the deployed bundle matches current workspace files. Vercel redeploys also inherit the original deployment's environment-variable snapshot, and generated deployment URLs can redirect to SSO while production aliases still serve public HTML.

**How to apply:** For workspace code changes, build and include current source files in the API deployment request, use the project ID and production target when newly configured project secrets must apply, and match the current `vercel.json` build/output settings. Confirm active aliases first, keep SSO and Clerk checks unchanged, and verify alias ownership and protected routes after the deployment is ready.

When the Vercel CLI is unavailable, direct-source releases can use Vercel's content-addressed file API: upload each included source file as `application/octet-stream` to `POST /v2/files` with its SHA-1 in `x-vercel-digest`, then call `POST /v13/deployments` with the project ID, `target: "production"`, and file references `{ file, sha, size }`. Exclude files according to `.vercelignore` so the remote build uses the current `vercel.json` configuration.

**Why:** This API flow successfully deployed the current workspace source without relying on the blocked CLI or inheriting an old deployment's source and environment snapshot.

**How to apply:** Upload source directly from the workspace without serializing the whole source bundle through tool output; wait for `READY`, then confirm production alias ownership and SSO/Clerk behavior.

For direct-source deployments, keep source bytes local to the impure upload routine. Use shell output only for a compact path/size manifest, read workspace-relative source paths with `node:fs/promises` inside the impure function, and pace `/v2/files` uploads at no more than five requests per second. The current Vercel connector's `proxyFetch` accepts a Node Buffer as the raw body for `/v2/files` when sent with `application/octet-stream`, `Content-Length`, and `x-vercel-digest`; do not assume this behavior for other connectors.

**Why:** A batch of 270 `readFile` callbacks exceeded the durable notebook's 32 MiB limit, while a concurrent upload burst hit the connector proxy's 10-requests-per-second rate limit. Large shell output can also be silently truncated. Buffer upload through the Vercel proxy avoids exposing credentials and avoids base64-expanding the source payload.

**How to apply:** Avoid printing or retaining the full source bundle in durable callback state; retry throttled uploads after a cooldown and create the deployment only after all file references are available.

Inside CodeExecution's impure runtime, `process.cwd` may not be available as a function. For direct-source uploads, use the workspace root verified from the shell instead of relying on `process.cwd()`.

**Why:** The durable runtime shadows Node's `process` object, so an otherwise standard working-directory call failed before the Vercel upload started.

**How to apply:** Resolve the workspace root outside the impure function and pass or use that explicit absolute path for local source reads.

When sending source manifests through shell callbacks, preserve filenames with non-ASCII characters; default `git ls-files` output may quote them into strings that are not actual paths.

**Why:** A direct-source upload attempted to read a quoted Unicode filename and failed before uploading; a JSON-serialized `git ls-files -z` manifest preserved the real path.

**How to apply:** Serialize null-delimited Git paths as JSON before passing them through callbacks, then filter them according to `.vercelignore`.

The current Vercel SSO mode protects generated production deployment URLs and all previews, while stable production aliases remain available for the public guest market page. A signed-out account API request should still be rejected by Clerk.

**Why:** In the current project configuration, the new deployment URL redirects to Vercel SSO, production aliases serve the guest page, and `/api/account/me` returns 401 without a Clerk session.

**How to apply:** Verify both the deployment URL and stable aliases after a release. Do not change SSO to protect every domain unless the user accepts that public guest access will be blocked.

For alias verification in this project, `/v4/aliases` queried with an exact `domain` returned no records even though the aliases were active; querying by `projectId` returned their deployment owners.

**Why:** The exact-domain filter gave a false impression that the existing production aliases were absent.

**How to apply:** Verify aliases through the deployment's `/v2/deployments/{id}/aliases` endpoint or list by `projectId` and compare each alias's `deploymentId`.

When a protected route sends a signed-out visitor to sign-in, preserve the intended destination using an app-owned allowlisted return value, not an arbitrary redirect URL. Continue checking the user's role after returning.

**Why:** The sign-in page's general fallback returned people to the dashboard instead of the protected route, while accepting arbitrary redirect targets would be unsafe.

**How to apply:** Map a finite return key to a known internal route, force that route after sign-in, and keep the route and API authorization checks in place.

For external Clerk invitations, a successful invitation API response or a `pending` invitation record confirms invitation creation, not email delivery. `notify: true` requests a notification but does not expose delivery status to the app.

**Why:** Production invitations were created successfully while recipients did not receive email; the Clerk invitation list showed only its pending lifecycle state, and the user confirmed “Deliver by Clerk” is enabled.

**How to apply:** Do not infer email delivery from invitation status. Check Clerk delivery evidence or ask Clerk support to trace the attempt; the production sender is Clerk-managed unless its setting changes.

The admin roster includes all Clerk accounts, including accounts without the app's active access marker, and identifies their app access separately. Uninvited accounts may only be reversibly banned or unbanned from the roster; do not permanently delete them or grant them a role.

**Why:** The user chose reversible account suspension with data retained, while keeping app access invite-only.

**How to apply:** Treat roster visibility as account administration, not authorization. Keep role controls limited to accounts with active app access and preserve the existing invite-only access checks.

If the Clerk Dashboard displays a `Communication locked` banner during invite troubleshooting, treat it as an account-level delivery restriction and use its `Contact support` action before changing or redeploying app code.

**Why:** A production invitation can remain pending while Clerk's dashboard visibly reports communications are locked.

**How to apply:** Check for this banner before investigating app-level email delivery or attempting repeated invitations.

The stable Vercel production alias currently bundles Clerk development keys; keep authentication configuration unchanged unless the user confirms the intended live-instance key pair.

**Why:** The production bundle logs Clerk's development-instance warning, and changing the key pair without confirmation could send users to a different account directory or block sign-in.

**How to apply:** Verify the production key modes and pairing without printing values, preserve Vercel SSO and invite-only role checks, and use the approved secrets flow for any confirmed change.