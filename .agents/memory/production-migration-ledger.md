---
name: Neon production migration ledger
description: Production Drizzle history can lag behind schema objects that already exist.
---

On this dashboard's Neon production database, the Drizzle journal once omitted migrations whose tables, constraints, and indexes were already present. Before applying later migrations, compare the missing migration definitions with the live schema. Backfill only the exact verified history entries for objects that already exist, then use the repository's gated production migrator for pending SQL. Stop if any part of the schema differs; do not blindly rerun DDL or bypass the gate.

Drizzle also reads every migration file in journal order before checking which migrations have already run. A journal entry whose SQL file is missing blocks even development migrations; restore the exact migration from verified schema history rather than skipping or renumbering it.

For MCP-prepared migrations, verify the full change set on its temporary branch and preserve the exact migration SQL, hashes, and journal timestamps in the completion call. The Neon migration preparer can split semicolons inside `DO $$` blocks and comment markers; when that occurs, use an equivalent DDL rewrite only after confirming the constraint does not already exist, while retaining the original migration hash and timestamp.

**Why:** The normal production migrator correctly stopped when journal history and actual schema diverged; blindly replaying those migrations could collide with existing tables. Missing SQL files also stop the migrator before applied-state checks.

**How to apply:** Read the current journal and inspect each object created by any missing migration, including columns, nullability, checks, foreign keys, and indexes. Restore missing SQL from verified history, and only reconcile production ledger metadata after the live schema matches exactly; then use the gated production migrator.
