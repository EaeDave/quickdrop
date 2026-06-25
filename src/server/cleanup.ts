import { loadConfig } from "./config";
import { deleteObject, createR2Client } from "./r2";
import { findExpired, markDeleted } from "./uploads-repository";
import { releaseExpiredStorageReservations } from "./storage-quota";

export async function cleanupExpiredUploads(
  now = new Date(),
): Promise<{ scanned: number; deleted: number; failed: number; releasedReservations: number; releasedReservationBytes: number }> {
  const releasedReservations = await releaseExpiredStorageReservations(now);
  const config = loadConfig();
  const r2Client = createR2Client(config);
  const expiredUploads = await findExpired(now, 500);
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

  return {
    scanned: expiredUploads.length,
    deleted,
    failed,
    releasedReservations: releasedReservations.released,
    releasedReservationBytes: releasedReservations.bytes,
  };
}

export function startCleanupJob(): NodeJS.Timeout {
  const timer = setInterval(() => {
    cleanupExpiredUploads().catch((error) => {
      console.error("Failed to run cleanup job", error);
    });
  }, 5 * 60 * 1000);

  timer.unref();
  return timer;
}
