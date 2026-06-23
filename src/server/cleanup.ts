import { loadConfig } from "./config";
import { deleteObject, createR2Client } from "./r2";
import { findExpired, markDeleted } from "./uploads-repository";

export async function cleanupExpiredUploads(now = new Date()): Promise<{ scanned: number; deleted: number; failed: number }> {
  const config = loadConfig();
  const r2Client = createR2Client(config);
  const expiredUploads = await findExpired(now, 100);
  let deleted = 0;
  let failed = 0;

  for (const upload of expiredUploads) {
    try {
      await deleteObject({ client: r2Client, bucket: config.r2BucketName, key: upload.r2_key });
      await markDeleted(upload.id, now);
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error("Failed to cleanup expired upload", { id: upload.id, error });
    }
  }

  return { scanned: expiredUploads.length, deleted, failed };
}

export function startCleanupJob(): NodeJS.Timeout {
  const timer = setInterval(() => {
    cleanupExpiredUploads().catch((error) => {
      console.error("Failed to run cleanup job", error);
    });
  }, 60 * 60 * 1000);

  timer.unref();
  return timer;
}
