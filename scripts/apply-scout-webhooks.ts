// scripts/apply-scout-webhooks.ts
//
// Applies sql/scout_webhooks.sql to the CLOUD database (scout_* tables live on
// Supabase Cloud, not the box). Idempotent — every statement is IF NOT EXISTS.
//
//   bun run scripts/apply-scout-webhooks.ts
//
// Reads DATABASE_URL from the backend .env (bun auto-loads it).

import { Client } from "pg";
import { readFileSync } from "fs";
import { join } from "path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set — run from the backend root so .env loads.");
  process.exit(1);
}

const sql = readFileSync(join(import.meta.dir, "..", "sql", "scout_webhooks.sql"), "utf8");

const client = new Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();
  const host = new URL(url.replace(/^postgres(ql)?:\/\//, "http://")).host;
  console.log(`connected → ${host}`);

  await client.query(sql);
  console.log("schema applied ✓");

  const { rows } = await client.query(`
    SELECT table_name, (SELECT count(*) FROM information_schema.columns c
                        WHERE c.table_name = t.table_name) AS cols
    FROM information_schema.tables t
    WHERE table_name IN ('scout_lobby_webhooks','scout_webhook_posted')
    ORDER BY table_name
  `);
  console.table(rows);
} catch (e: any) {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
} finally {
  await client.end();
}
