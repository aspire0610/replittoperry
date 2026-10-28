const productionDatabaseUrl = process.env.MARKET_SCAN_DATABASE_URL?.trim();

if (!productionDatabaseUrl) {
  throw new Error(
    "MARKET_SCAN_DATABASE_URL is required for the production market scan worker.",
  );
}

if (!/^postgres(?:ql)?:\/\//i.test(productionDatabaseUrl)) {
  throw new Error(
    "MARKET_SCAN_DATABASE_URL must be a PostgreSQL connection URL.",
  );
}

// Override only this worker process; leave the API and other workflows on their
// existing DATABASE_URL.
process.env.DATABASE_URL = productionDatabaseUrl;
