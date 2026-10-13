# Deploying the Vite dashboard to Vercel

This repository-root Vercel configuration builds the React/Vite dashboard as a
static site and routes `/api/*` requests to the shared Express API through
`api/[...path].ts`. The Replit preview uses the same API routes from the managed
API server.

## Production deploy from this repository

The root `deploy:vercel` command uploads the current repository source through
Vercel's content-addressed deployment API. It does not require the Vercel CLI,
which is useful in this workspace where installing that CLI is blocked.

Prerequisites:

- Run the command from the repository root in the existing linked workspace.
  `.vercel/project.json` identifies the existing `tw-stock-dashboard` project;
  it is local Vercel link metadata and should remain uncommitted.
- `VERCEL_TOKEN` must be available as a Replit Secret and have access to that
  Vercel team and project. The token is read by the script and is never printed.
- Commit the intended changes and use a clean Git working tree. The script
  refuses to deploy an uncommitted or untracked source tree.

1. Preview the source selection without uploading or deploying:

   ```sh
   pnpm run deploy:vercel -- --dry-run
   ```

2. Start the Production deployment:

   ```sh
   pnpm run deploy:vercel
   ```

The script runs the build command from the root `vercel.json` before uploading.
It selects tracked repository files, applies `.vercelignore`, uploads them to
Vercel, then creates a Production deployment for the project in
`.vercel/project.json`. It waits for Vercel to report `READY` and prints the
deployment URL and any assigned aliases. The project ID and team ID are used
only to target this existing project.

The API request intentionally omits project settings and environment-variable
fields. It does not change the Vercel project's build settings, Clerk access,
SSO protection, or Neon/database environment values. Those values remain managed
in the existing Vercel project. The upload uses the repository's
`.vercelignore`; `scripts/package.json` is retained because pnpm's lockfile
contains that workspace importer, while the deploy helper itself is excluded.

After a deployment reaches `READY`, verify the assigned production alias and
the protected account/API behavior using the existing release checks. A
successful build URL alone does not confirm alias ownership or signed-in access.

If the local `.vercel/project.json` link metadata is missing, stop and restore
the link to the existing project before deploying. Do not create a new Vercel
project or copy environment values into the repository.

The live TAIEX quote uses TWSE MIS. TAIEX history comes from TWSE Open Data,
and listed/OTC stock history comes from TWSE / TPEx. The Taiwan futures quote
uses Yahoo Finance and can be unavailable when that provider rate-limits
requests. Provider limitations are shown as errors rather than being replaced
with generated prices. Data timing depends on the provider.