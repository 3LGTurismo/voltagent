#!/usr/bin/env node
/**
 * VoltAgent Migration Runner
 *
 * Executes SQL migrations in order against PostgreSQL.
 * Similar to nodus-teste/scripts/run_migrations.py
 *
 * Usage: npx tsx scripts/run-migrations.ts [--database-url URL] [--dry-run]
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

interface MigrationFile {
  number: number;
  name: string;
  path: string;
}

function getMigrationFiles(): MigrationFile[] {
  const migrations: MigrationFile[] = [];

  for (const file of readdirSync(MIGRATIONS_DIR)) {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (match) {
      migrations.push({
        number: Number.parseInt(match[1], 10),
        name: file,
        path: join(MIGRATIONS_DIR, file),
      });
    }
  }

  migrations.sort((a, b) => a.number - b.number);
  return migrations;
}

async function ensureMigrationTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voltagent_schema_migrations (
      id SERIAL PRIMARY KEY,
      migration_number INTEGER NOT NULL UNIQUE,
      migration_name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      checksum VARCHAR(64)
    )
  `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<number>> {
  const result = await pool.query("SELECT migration_number FROM voltagent_schema_migrations");
  return new Set(result.rows.map((row) => row.migration_number));
}

async function applyMigration(
  pool: Pool,
  number: number,
  name: string,
  content: string,
  dryRun = false,
): Promise<boolean> {
  const crypto = await import("node:crypto");
  const checksum = crypto.createHash("sha256").update(content).digest("hex");

  console.log(`  Applying migration ${number}: ${name}`);

  if (dryRun) {
    console.log("    [DRY RUN] Would execute migration");
    return true;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Execute migration
    await client.query(content);

    // Record in migration table
    await client.query(
      `
      INSERT INTO voltagent_schema_migrations (migration_number, migration_name, checksum)
      VALUES ($1, $2, $3)
      ON CONFLICT (migration_number) DO UPDATE SET
        migration_name = EXCLUDED.migration_name,
        checksum = EXCLUDED.checksum,
        applied_at = NOW()
    `,
      [number, name, checksum],
    );

    await client.query("COMMIT");
    console.log(`    ✓ Migration ${number} applied successfully`);
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`    ✗ Migration ${number} FAILED:`, error);
    return false;
  } finally {
    client.release();
  }
}

async function runMigrations(
  databaseUrl: string = process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/crm_ai",
  dryRun = false,
): Promise<boolean> {
  console.log("🔧 VoltAgent Migration Runner");
  console.log("===============================\n");

  console.log("Connecting to database...");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 5000,
  });

  try {
    await ensureMigrationTable(pool);
    const applied = await getAppliedMigrations(pool);

    const migrations = getMigrationFiles();
    console.log(`Found ${migrations.length} migration file(s)`);
    console.log(`Already applied: ${Array.from(applied).sort().join(", ") || "none"}`);

    const pending = migrations.filter((m) => !applied.has(m.number));

    if (pending.length === 0) {
      console.log("\n✅ No pending migrations.");
      return true;
    }

    console.log(`\nPending migrations: ${pending.map((m) => m.number).join(", ")}`);

    if (dryRun) {
      console.log("\n=== DRY RUN MODE ===\n");
    }

    let allSuccess = true;
    for (const migration of pending) {
      const content = readFileSync(migration.path, "utf-8");
      const success = await applyMigration(pool, migration.number, migration.name, content, dryRun);
      if (!success) {
        allSuccess = false;
        break;
      }
    }

    if (allSuccess && !dryRun) {
      console.log("\n🎉 All migrations applied successfully!");
    } else if (dryRun) {
      console.log("\n✅ Dry run completed (no changes made)");
    } else {
      console.log("\n❌ Some migrations failed!");
    }

    return allSuccess;
  } finally {
    await pool.end();
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  let databaseUrl = process.env.DATABASE_URL;
  const dbUrlArg = args.find((a) => a.startsWith("--database-url="));
  if (dbUrlArg) {
    databaseUrl = dbUrlArg.split("=")[1];
  }

  if (!databaseUrl) {
    console.error(
      "❌ DATABASE_URL not provided. Set DATABASE_URL env var or use --database-url=...",
    );
    process.exit(1);
  }

  const success = await runMigrations(databaseUrl, dryRun);
  process.exit(success ? 0 : 1);
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
