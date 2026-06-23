import { SQL } from "bun";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

async function migrate() {
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const database = new SQL(databaseUrl);
  const migrationsDir = "migrations";
  const migrationFiles = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  try {
    await waitForDatabase(database);

    for (const migrationFile of migrationFiles) {
      const migrationPath = join(migrationsDir, migrationFile);
      const sqlText = await Bun.file(migrationPath).text();

      console.log(`Applying ${migrationFile}`);
      await database.unsafe(sqlText);
    }
  } finally {
    await database.close();
  }
}

async function waitForDatabase(database: SQL): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await database`select 1`;
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(500);
    }
  }

  throw lastError ?? new Error("Database did not become ready");
}

migrate().catch((error) => {
  console.error(error);
  process.exit(1);
});
