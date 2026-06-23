import type { Multipart } from "@fastify/multipart";
import type { S3Client } from "@aws-sdk/client-s3";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Transform } from "node:stream";
import type { AppConfig } from "./config";
import { computeExpiresAt } from "./expiration";
import { buildR2Key, generateShortId, generateUploadId, sanitizeFilename } from "./ids";
import { putObject, deleteObject } from "./r2";
import { insertUpload } from "./uploads-repository";

export type UploadResponse = { id: string; url: string; expiresAt: string };
export type UploadDeps = { config: AppConfig; r2Client: S3Client };

type UploadedObject = {
  id: string;
  key: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number;
  createdAt: Date;
};

class FileTooLargeAfterUploadError extends Error {
  readonly code = "QUICKDROP_FILE_TOO_LARGE";

  constructor() {
    super("file too large");
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

  const declaredFileSizeBytes = readDeclaredFileSizeBytes(request.headers["x-quickdrop-file-size"]);

  if (declaredFileSizeBytes && declaredFileSizeBytes > deps.config.maxFileSizeBytes) {
    sendUploadError(
      reply,
      413,
      "file_too_large",
      `Arquivo excede o limite de ${deps.config.maxFileSizeMb} MB.`,
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

      uploadedObject = await uploadMultipartFile(part, deps, declaredFileSizeBytes);
    }
  } catch (error) {
    if (uploadedObject) {
      await deleteUploadedObject(deps, uploadedObject.key);
    }

    if (hasErrorCode(error, "FST_FILES_LIMIT")) {
      sendUploadError(reply, 400, "too_many_files", "Envie apenas um arquivo por vez.");
      return;
    }

    if (hasErrorCode(error, "FST_REQ_FILE_TOO_LARGE") || hasErrorCode(error, "QUICKDROP_FILE_TOO_LARGE")) {
      sendUploadError(
        reply,
        413,
        "file_too_large",
        `Arquivo excede o limite de ${deps.config.maxFileSizeMb} MB.`,
      );
      return;
    }

    request.log.error({ error }, "Failed to store upload");
    sendUploadError(reply, 500, "upload_failed", "Falha ao enviar arquivo.");
    return;
  }

  if (!uploadedObject) {
    sendUploadError(reply, 400, "file_required", "Selecione um arquivo.");
    return;
  }

  if (uploadedObject.sizeBytes === 0) {
    await deleteUploadedObject(deps, uploadedObject.key);
    sendUploadError(reply, 400, "empty_file", "Arquivo vazio não é permitido.");
    return;
  }

  const expiresAt = computeExpiresAt(uploadedObject.createdAt, deps.config.fileExpirationHours);

  try {
    const row = await insertUploadWithRetries({
      id: uploadedObject.id,
      originalName: uploadedObject.originalName,
      mimeType: uploadedObject.mimeType,
      sizeBytes: uploadedObject.sizeBytes,
      r2Key: uploadedObject.key,
      createdAt: uploadedObject.createdAt,
      expiresAt,
    });

    reply.code(201);
    return {
      id: row.id,
      url: `${deps.config.publicBaseUrl}/f/${row.short_id}`,
      expiresAt: row.expires_at.toISOString(),
    };
  } catch (error) {
    await deleteUploadedObject(deps, uploadedObject.key);
    request.log.error({ error }, "Failed to register upload");
    sendUploadError(reply, 500, "upload_failed", "Falha ao registrar upload.");
  }
}

async function uploadMultipartFile(part: Multipart, deps: UploadDeps, contentLength: number | undefined): Promise<UploadedObject> {
  if (part.type !== "file") {
    throw new Error("Expected multipart file");
  }

  const id = generateUploadId();
  const originalName = sanitizeFilename(part.filename);
  const createdAt = new Date();
  const key = buildR2Key(id, originalName, createdAt);
  let sizeBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      sizeBytes += byteLengthOfChunk(chunk);
      callback(null, chunk);
    },
  });

  await putObject({
    client: deps.r2Client,
    bucket: deps.config.r2BucketName,
    key,
    body: part.file.pipe(counter),
    contentType: part.mimetype || undefined,
    contentLength,
  });

  if (part.file.truncated) {
    await deleteUploadedObject(deps, key);
    throw new FileTooLargeAfterUploadError();
  }

  return {
    id,
    key,
    originalName,
    mimeType: part.mimetype || null,
    sizeBytes,
    createdAt,
  };
}

async function insertUploadWithRetries(input: {
  id: string;
  originalName: string;
  mimeType: string | null;
  sizeBytes: number;
  r2Key: string;
  createdAt: Date;
  expiresAt: Date;
}) {
  let lastUniqueError: unknown;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await insertUpload({
        ...input,
        shortId: generateShortId(),
      });
    } catch (error) {
      if (!hasPostgresUniqueViolation(error)) {
        throw error;
      }

      lastUniqueError = error;
    }
  }

  throw lastUniqueError ?? new Error("Could not generate a unique short_id");
}

async function deleteUploadedObject(deps: UploadDeps, key: string): Promise<void> {
  try {
    await deleteObject({ client: deps.r2Client, bucket: deps.config.r2BucketName, key });
  } catch (error) {
    console.error("Failed to delete R2 object after upload failure", error);
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

function hasPostgresUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  while (current && typeof current === "object") {
    if ("code" in current && current.code === "23505") {
      return true;
    }

    if (!("cause" in current)) {
      return false;
    }

    current = current.cause;
  }

  return false;
}
