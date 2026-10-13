import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const productionEndpointId = "ep-ancient-meadow-b8o7mii3";
const isProductionHost = (hostname) =>
  hostname.startsWith(`${productionEndpointId}.`) ||
  hostname.startsWith(`${productionEndpointId}-`) &&
    hostname.endsWith(".c-14.us-east-1.aws.neon.tech");

const target = process.argv[2];
if (target !== "development" && target !== "production") {
  throw new Error("Choose a migration target: development or production.");
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to apply migrations.");
}

let databaseUrl;
try {
  databaseUrl = new URL(connectionString);
} catch {
  throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
}

if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
  throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
}

if (target === "production") {
  if (!isProductionHost(databaseUrl.hostname)) {
    throw new Error(
      "Production migrations require the configured tw-stock-dashboard-prod Neon endpoint. Verify DATABASE_URL comes from Vercel Production.",
    );
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      "Production migrations require an interactive terminal so the target can be confirmed.",
    );
  }

  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1)) || "(default)";
  stdout.write(
    `Target: Neon production host ${databaseUrl.hostname}, database ${databaseName}.\n` +
      "This will apply every pending SQL migration to the production database.\n" +
      'Type "APPLY tw-stock-dashboard-prod PRODUCTION MIGRATIONS" to continue: ',
  );
  const readline = createInterface({ input: stdin, output: stdout });
  const confirmation = await readline.question("");
  readline.close();
  if (confirmation !== "APPLY tw-stock-dashboard-prod PRODUCTION MIGRATIONS") {
    throw new Error("Production migration was not confirmed; no SQL was applied.");
  }
} else {
  if (isProductionHost(databaseUrl.hostname)) {
    throw new Error(
      "Development migrations refuse the tw-stock-dashboard-prod endpoint. Use the production command so it requires explicit confirmation.",
    );
  }
  stdout.write(
    `Applying pending migrations to the explicitly selected development database at ${databaseUrl.hostname}.\n`,
  );
}

const { Pool } = pg;
const pool = new Pool({ connectionString });
const db = drizzle(pool);
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle",
);

try {
  await migrate(db, { migrationsFolder });
  stdout.write(`Database ${target} migration completed.\n`);
} finally {
  await pool.end();
}
