# Database migrations

`src/schema/` is the Drizzle schema source of truth. Committed, ordered SQL
migrations and their Drizzle snapshots live in `drizzle/`. Importing the
database client or starting an API service never applies DDL.

## Creating and testing a change

1. Update the relevant schema file and export it from `src/schema/index.ts`.
2. Generate and review the migration:

   ```sh
   pnpm --filter @workspace/db run generate --name=describe-change
   ```

   Commit the generated SQL, `meta/_journal.json`, and snapshot alongside the
   schema change. Review that the SQL only contains the intended tables,
   columns, constraints, and indexes.
3. Test the migration in a fresh database on an isolated Neon branch. The
   branch test should replay every committed migration in order and verify the
   expected tables and indexes. Do not test migrations against the production
   branch or Replit development database.
4. Apply to development explicitly with
   `pnpm --filter @workspace/db run migrate:dev` and the Replit development
   `DATABASE_URL`.
5. Apply to production only as a separate operator action:
   `pnpm --filter @workspace/db run migrate:production`. Supply the Neon
   production `DATABASE_URL` from Vercel's **Production** environment. The
   command prints only the hostname and database name and requires typing
   `APPLY tw-stock-dashboard-prod PRODUCTION MIGRATIONS` before it runs.
   `migrate:dev` refuses the configured production endpoint, so the Replit
   development command cannot bypass the production confirmation gate. If
   Neon recreates the production endpoint, update its endpoint ID in
   `scripts/migrate.mjs`. Never run the production command as an application
   startup hook, build step, or routine deployment hook.

## Environment separation

| Environment | Database | How it is used |
| --- | --- | --- |
| Development | Replit's development PostgreSQL, provided to local/workspace processes as `DATABASE_URL` | For development and explicitly invoked `migrate:dev`; isolated Neon branches are used to validate migration SQL. |
| Production | Separate Neon project `tw-stock-dashboard-prod`, `production` branch, database `neondb`; Vercel Production supplies its own `DATABASE_URL` | Not changed by Replit publish or app startup. Apply migrations only with the gated `migrate:production` command after review and explicit confirmation. |

Never copy a production connection string into Replit development secrets or
use the development URL for a production migration. Keep all connection
strings out of source control, logs, and chat.

The first migration is an idempotent baseline: it creates an object only when
that table or index is absent. Before adopting it on an existing database,
compare the existing columns, types, constraints, and indexes with the
baseline. `IF NOT EXISTS` does not repair a same-named object whose definition
differs.
