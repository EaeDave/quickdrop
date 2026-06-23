import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";
import type { AppConfig } from "./config";

export function createR2Client(config: AppConfig): S3Client {
  return new S3Client({
    region: "auto",
    requestChecksumCalculation: "WHEN_REQUIRED",
    requestHandler: new NodeHttpHandler(),
    responseChecksumValidation: "WHEN_REQUIRED",
    endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });
}

export async function putObject(input: {
  client: S3Client;
  bucket: string;
  key: string;
  body: Readable;
  contentType: string | undefined;
  contentLength: number | undefined;
}): Promise<void> {
  await input.client.send(
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    }),
  );
}

export async function deleteObject(input: { client: S3Client; bucket: string; key: string }): Promise<void> {
  await input.client.send(
    new DeleteObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
    }),
  );
}

export async function signedDownloadUrl(input: {
  client: S3Client;
  bucket: string;
  key: string;
  originalName: string;
  expiresInSeconds: number;
}): Promise<string> {
  const fallbackName = input.originalName.replace(/["\\\r\n]/g, "_");
  const command = new GetObjectCommand({
    Bucket: input.bucket,
    Key: input.key,
    ResponseContentDisposition: `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(input.originalName)}`,
  });

  return getSignedUrl(input.client, command, { expiresIn: input.expiresInSeconds });
}
