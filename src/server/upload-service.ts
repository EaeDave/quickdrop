import type { Multipart, MultipartFile } from "@fastify/multipart";
import type { S3Client } from "@aws-sdk/client-s3";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppConfig } from "./config";
import { computeExpiresAt } from "./expiration";
import { buildR2Key, generateUploadId, sanitizeFilename } from "./ids";
import { putObject, deleteObject } from "./r2";
import {
  registerUploadWithStorageReservation,
  releaseUploadStorageReservation,
  reserveUploadStorage,
} from "./storage-quota";
import { markDeleted } from "./uploads-repository";

export type UploadResponse = { id: string; url: string; expiresAt: string };

type StorageQuotaGateway = {
  reserveUploadStorage: typeof reserveUploadStorage;
  registerUploadWithStorageReservation: typeof registerUploadWithStorageReservation;
  releaseUploadStorageReservation: typeof releaseUploadStorageReservation;
};

export type UploadDeps = { config: AppConfig; r2Client: S3Client; storageQuota?: StorageQuotaGateway };

const defaultStorageQuotaGateway: StorageQuotaGateway = {
  reserveUploadStorage,
  registerUploadWithStorageReservation,
  releaseUploadStorageReservation,
};

type UploadedObject = {
  id: string;
  shortId: string;
  key: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: Date;
  expiresAt: Date;
};

type SpooledUpload = {
  path: string;
  directory: string;
  sizeBytes: number;
};

class FileTooLargeAfterUploadError extends Error {
  readonly code = "QUICKDROP_FILE_TOO_LARGE";

  constructor() {
    super("file too large");
  }
}

class EmptyFileUploadError extends Error {
  readonly code = "QUICKDROP_EMPTY_FILE";

  constructor() {
    super("empty file");
  }
}

class UploadsDisabledError extends Error {
  readonly code = "QUICKDROP_UPLOADS_DISABLED";

  constructor() {
    super("uploads disabled");
  }
}

class StorageQuotaExceededError extends Error {
  readonly code = "QUICKDROP_STORAGE_QUOTA_EXCEEDED";

  constructor() {
    super("storage quota exceeded");
  }
}

export async function handleUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: UploadDeps,
): Promise<UploadResponse | void> {
  if (!request.isMultipart()) {
    sendUploadError(reply, 415, "invalid_multipart", "Envie multipart/form-data com o campo file.");
    return;
  }

  if (!deps.config.uploadsEnabled) {
    sendUploadError(reply, 503, "uploads_disabled", "Uploads temporariamente desativados.");
    return;
  }

  const declaredFileSizeBytes = readDeclaredFileSizeBytes(request.headers["x-quickdrop-file-size"]);

  if (declaredFileSizeBytes && declaredFileSizeBytes > deps.config.maxFileSizeBytes) {
    sendUploadError(
      reply,
      413,
      "file_too_large",
      `File exceeds the ${deps.config.maxFileSizeMb} MB limit.`,
    );
    return;
  }

  let uploadedObject: UploadedObject | null = null;

  try {
    for await (const part of request.parts({
      limits: { files: 1, fileSize: deps.config.maxFileSizeBytes },
    })) {
      if (part.type !== "file") {
        continue;
      }

      if (part.fieldname !== "file" || uploadedObject) {
        await drainMultipartFile(part);
        continue;
      }

      uploadedObject = await uploadMultipartFile(part, deps);
    }
  } catch (error) {
    if (uploadedObject) {
      await deleteRegisteredUpload(deps, uploadedObject);
    }

    if (hasErrorCode(error, "FST_FILES_LIMIT")) {
      sendUploadError(reply, 400, "too_many_files", "Send only one file at a time.");
      return;
    }

    if (hasErrorCode(error, "FST_REQ_FILE_TOO_LARGE") || hasErrorCode(error, "QUICKDROP_FILE_TOO_LARGE")) {
      sendUploadError(
        reply,
        413,
        "file_too_large",
        `File exceeds the ${deps.config.maxFileSizeMb} MB limit.`,
      );
      return;
    }

    if (hasErrorCode(error, "QUICKDROP_EMPTY_FILE")) {
      sendUploadError(reply, 400, "empty_file", "Empty files are not allowed.");
      return;
    }

    if (hasErrorCode(error, "QUICKDROP_UPLOADS_DISABLED")) {
      sendUploadError(reply, 503, "uploads_disabled", "Uploads temporariamente desativados.");
      return;
    }

    if (hasErrorCode(error, "QUICKDROP_STORAGE_QUOTA_EXCEEDED")) {
      sendUploadError(reply, 507, "storage_quota_exceeded", "Temporary storage limit reached.");
      return;
    }
    request.log.error({ error }, "Failed to store upload");
    sendUploadError(reply, 500, "upload_failed", "File upload failed.");
    return;
  }

  if (!uploadedObject) {
    sendUploadError(reply, 400, "file_required", "Select a file.");
    return;
  }

  reply.code(201);
  return {
    id: uploadedObject.id,
    url: `${deps.config.publicBaseUrl}/f/${uploadedObject.shortId}`,
    expiresAt: uploadedObject.expiresAt.toISOString(),
  };
}

async function uploadMultipartFile(part: MultipartFile, deps: UploadDeps): Promise<UploadedObject> {
  if (part.type !== "file") {
    throw new Error("Expected multipart file");
  }

  const id = generateUploadId();
  const originalName = sanitizeFilename(part.filename);
  const createdAt = new Date();
  const expiresAt = computeExpiresAt(createdAt, deps.config.fileExpirationHours);
  const key = buildR2Key(id, originalName, createdAt);
  const spooledUpload = await spoolMultipartFile(part, deps.config.maxFileSizeBytes);
  const storageQuota = deps.storageQuota ?? defaultStorageQuotaGateway;
  let reservationId: string | null = null;
  let registeredUpload: UploadedObject | null = null;

  try {
    if (spooledUpload.sizeBytes === 0) {
      throw new EmptyFileUploadError();
    }

    const reservation = await storageQuota.reserveUploadStorage({
      sizeBytes: spooledUpload.sizeBytes,
      hardLimitBytes: deps.config.r2StorageHardLimitBytes,
      reservationTtlMs: deps.config.uploadReservationTtlMinutes * 60 * 1000,
      uploadsEnabled: deps.config.uploadsEnabled,
      now: createdAt,
    });

    if (!reservation.ok) {
      if (reservation.reason === "disabled") {
        throw new UploadsDisabledError();
      }

      throw new StorageQuotaExceededError();
    }

    reservationId = reservation.reservation.id;

    const row = await storageQuota.registerUploadWithStorageReservation({
      reservationId,
      id,
      originalName,
      mimeType: part.mimetype || null,
      sizeBytes: spooledUpload.sizeBytes,
      r2Key: key,
      createdAt,
      expiresAt,
    });

    registeredUpload = {
      id: row.id,
      shortId: row.short_id,
      key,
      originalName,
      mimeType: part.mimetype || null,
      sizeBytes: spooledUpload.sizeBytes,
      createdAt,
      expiresAt: row.expires_at,
    };
    reservationId = null;

    try {
      await putObject({
        client: deps.r2Client,
        bucket: deps.config.r2BucketName,
        key,
        body: createReadStream(spooledUpload.path),
        contentType: part.mimetype || undefined,
        contentLength: spooledUpload.sizeBytes,
      });
    } catch (error) {
      await deleteRegisteredUpload(deps, registeredUpload);
      throw error;
    }

    return registeredUpload;
  } catch (error) {
    if (reservationId) {
      await storageQuota.releaseUploadStorageReservation(reservationId);
    }

    throw error;
  } finally {
    await removeSpooledUpload(spooledUpload.directory);
  }
}

async function spoolMultipartFile(part: MultipartFile, maxFileSizeBytes: number): Promise<SpooledUpload> {
  const directory = await mkdtemp(join(tmpdir(), "quickdrop-upload-"));
  const path = join(directory, "payload");
  let sizeBytes = 0;

  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      sizeBytes += byteLengthOfChunk(chunk);

      if (sizeBytes > maxFileSizeBytes) {
        callback(new FileTooLargeAfterUploadError());
        return;
      }

      callback(null, chunk);
    },
  });

  try {
    await pipeline(part.file, counter, createWriteStream(path));
  } catch (error) {
    await removeSpooledUpload(directory);
    throw error;
  }

  if (part.file.truncated) {
    await removeSpooledUpload(directory);
    throw new FileTooLargeAfterUploadError();
  }

  return { path, directory, sizeBytes };
}

async function removeSpooledUpload(directory: string): Promise<void> {
  try {
    await rm(directory, { force: true, recursive: true });
  } catch (error) {
    console.error({ error }, "Failed to remove temporary QuickDrop upload");
  }
}


async function deleteRegisteredUpload(deps: UploadDeps, upload: UploadedObject): Promise<void> {
  if (await deleteUploadedObject(deps, upload.key)) {
    await markDeleted(upload.id, new Date());
  }
}

async function deleteUploadedObject(deps: UploadDeps, key: string): Promise<boolean> {
  try {
    await deleteObject({ client: deps.r2Client, bucket: deps.config.r2BucketName, key });
    return true;
  } catch (error) {
    console.error("Failed to delete R2 object after upload failure", error);
    return false;
  }
}

async function drainMultipartFile(part: Multipart): Promise<void> {
  if (part.type !== "file") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    part.file.on("error", reject);
    part.file.on("end", resolve);
    part.file.resume();
  });
}

function sendUploadError(reply: FastifyReply, statusCode: number, error: string, message: string): void {
  reply.code(statusCode).send({ error, message });
}

function byteLengthOfChunk(chunk: unknown): number {
  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk);
  }

  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }

  return 0;
}

function readDeclaredFileSizeBytes(value: string | string[] | undefined): number | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;

  if (!rawValue) {
    return undefined;
  }

  const parsed = Number(rawValue);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  return typeof error.code === "string" && error.code === expectedCode;
}

