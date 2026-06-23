import { cleanupExpiredUploads } from "./cleanup";
import { sql } from "./db";

try {
  const result = await cleanupExpiredUploads(new Date());
  console.log(JSON.stringify(result));
  await sql.close();

  if (result.failed > 0) {
    process.exit(1);
  }
} catch (error) {
  console.error(error);
  await sql.close({ timeout: 0 });
  process.exit(1);
}
