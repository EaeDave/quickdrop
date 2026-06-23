import type { S3Client } from "@aws-sdk/client-s3";
import type { FastifyReply } from "fastify";
import type { AppConfig } from "./config";
import { computeSignedUrlExpirySeconds, isExpired } from "./expiration";
import { deleteObject, signedDownloadUrl } from "./r2";
import { findActiveByShortId, incrementDownloadCount, markDeleted } from "./uploads-repository";

export type DownloadDeps = { config: AppConfig; r2Client: S3Client };

export async function handleDownload(shortId: string, reply: FastifyReply, deps: DownloadDeps): Promise<void> {
  const upload = await findActiveByShortId(shortId);

  if (!upload || upload.deleted_at) {
    reply.code(404).send({ error: "not_found", message: "Arquivo não encontrado." });
    return;
  }

  const now = new Date();

  if (isExpired(upload.expires_at, now)) {
    await deleteObject({ client: deps.r2Client, bucket: deps.config.r2BucketName, key: upload.r2_key });
    await markDeleted(upload.id, now);
    reply.code(410).send({ error: "expired", message: "Arquivo expirado." });
    return;
  }

  await incrementDownloadCount(upload.id);
  const expiresInSeconds = computeSignedUrlExpirySeconds(upload.expires_at, now);
  const signedUrl = await signedDownloadUrl({
    client: deps.r2Client,
    bucket: deps.config.r2BucketName,
    key: upload.r2_key,
    originalName: upload.original_name,
    expiresInSeconds,
  });

  reply.redirect(signedUrl, 302);
}
