---
name: Vercel environment checks from Replit
description: Avoid false positives when validating Vercel variables from a Replit shell.
---

When running `vercel env run` from Replit, the child process can inherit same-named Replit secrets from its parent shell. A simple truthy check can therefore make a missing Vercel variable appear configured. Unset inherited names before checking the Vercel target, and report presence only rather than values. Vercel may also refuse to inject variables marked sensitive into this subprocess; a missing process variable after that warning does not prove the deployed function lacks it.

**Why:** Replit inheritance caused false positives when validating production Clerk variables, and Vercel's refusal to expose sensitive values can cause false negatives for production AI variables.

**How to apply:** Before checking a Vercel target from this workspace, unset matching Replit variables and print only presence booleans. If Vercel reports that sensitive variables cannot be pulled, verify the deployed behavior through a safe application check; use a live AI inference only when needed and account for its provider cost.

Vercel's environment-variable API can return a sensitive Production variable with `decrypted: false` and no value, including from the single-variable endpoint. Do not bypass that limitation or retrieve secrets from unrelated sources. If the user explicitly authorizes the connected Neon integration for this Neon database, it can supply the production connection for the project's existing gated migration command; never print or persist that connection.

**Why:** Sensitive variables remain intentionally unavailable through the connected API even when a caller requests decryption.

**How to apply:** For production migrations, prefer the documented gated command with an authorized Vercel environment. If that route is unavailable, only use the Neon integration when the user explicitly authorizes it, and still run the project's gated migration command rather than applying pending SQL manually.

Replit Secrets are not automatically copied into a Vercel project. For this dashboard, `FUGLE_API_KEY` had to be added separately to Vercel's Production environment; reusing a prior deployment snapshot did not supply it to the new function. After adding it in Vercel and creating a project-scoped deployment with current source, the Fugle intraday endpoint returned data.

**Why:** The production `/api/market/intraday` route kept reporting the key as unset even though the Replit Secret existed, because Vercel maintains a separate environment-variable set.

**How to apply:** Check Vercel target metadata without reading values. Have the user add missing keys directly to Vercel's secure settings UI, then create a project-scoped deployment; never copy secret values into chat, logs, source files, or transfer scripts.