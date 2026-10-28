---
name: Vercel deployment access
description: Deployment constraints when publishing this workspace to its unlinked Vercel project.
---

Vercel's Git link, production branch, and active production deployment are separate states. A complete-source API deployment can be READY and own the production alias without carrying a Git commit SHA; verify the live deployment target and alias rather than inferring production from branch or commit metadata.

**Why:** The project can be Git-linked and still be released through a direct full-source upload; the deployment metadata then has no Git commit to compare.

**How to apply:** Before and after release, inspect the project link/production branch and confirm the newest deployment is `target=production`, `READY`, and owns the expected alias. Use a complete validated source deployment; do not bypass the package firewall, push to Replit's internal Git remotes, or upload only changed files.

A local deploy command can time out after Vercel has accepted the deployment; the remote build may continue. Query Vercel for that deployment's final state before retrying to avoid creating duplicate production releases.

**Why:** The workspace command timed out while the Vercel deployment was still building, but that same deployment later reached `READY` and took over the production alias.

**How to apply:** If the deploy process loses its local wait, use the Vercel deployment API to inspect the created deployment and active alias before starting another deploy.

For Git-connected releases, set the Production Branch in Vercel's dashboard under Project Settings → Environments; the documented project-update API does not expose this setting. A READY deployment from a branch can still be a preview until the project reports that branch as its production branch and a production-target deployment is created.

**Why:** Vercel reported a READY branch deployment while the project still had `main` configured for production; after the user saved the branch setting, Vercel created a separate production deployment for the same Git commit.

**How to apply:** Verify both `project.link.productionBranch` and the deployment `target` before calling a Git-connected release live. If the branch was pushed before the production setting changed, trigger a new Git push after the setting is saved.

Replit may checkpoint edits into the current Git commit before a direct Vercel release. A later `git add`/`git commit` can therefore report that there is nothing to commit even though the intended changes are present.

**Why:** During a source upload, the deploy helper required a clean tree; the workspace had already committed the edited files to `HEAD`.

**How to apply:** Before creating another commit, inspect `git status` and confirm the intended paths are present in `HEAD`; then run the existing deployment helper against that clean source.

On the current Vercel Hobby plan, a deployment fails if it contains more than 12 Serverless Functions. For a new nested API path, prefer an explicit rewrite to an existing generic function plus a tightly allowlisted `__route` rewrite, rather than adding another function file.

**Why:** Adding a catch-all file for nested stock-research-agent actions exceeded the plan's per-deployment function limit; reusing the existing account function kept the deployment within the limit.

**How to apply:** Keep deep account paths mapped through the existing account function, validate the allowed rewritten paths, and verify an unauthenticated request returns the app's expected 401 rather than Vercel's 404.
