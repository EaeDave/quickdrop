export type AppConfig = {
  port: number;
  databaseUrl: string;
  r2AccountId: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2BucketName: string;
  publicBaseUrl: string;
  fileExpirationHours: number;
  maxFileSizeMb: number;
  maxFileSizeBytes: number;
  uploadRateLimitMax: number;
  uploadsEnabled: boolean;
  r2StorageHardLimitGb: number;
  r2StorageHardLimitBytes: number;
  uploadReservationTtlMinutes: number;
  githubToken: string | undefined;
  githubReleaseRepository: string;
  textSessionTtlHours: number;
  textCustomSessionTtlMinutes: number;
  textSessionMaxBytes: number;
  textSessionCodeLength: number;
  textSessionMaxSessions: number;
  textSessionMaxClientsPerSession: number;
};

const DEFAULT_PORT = 3000;
const DEFAULT_R2_BUCKET_NAME = "quickdrop";
const DEFAULT_FILE_EXPIRATION_HOURS = 6;
const DEFAULT_MAX_FILE_SIZE_MB = 100;
const DEFAULT_UPLOAD_RATE_LIMIT_MAX = 5;
const DEFAULT_R2_STORAGE_HARD_LIMIT_GB = 8;
const DEFAULT_UPLOAD_RESERVATION_TTL_MINUTES = 30;
const DEFAULT_GITHUB_RELEASE_REPOSITORY = "EaeDave/quickdrop";
const DEFAULT_TEXT_SESSION_TTL_HOURS = 12;
const DEFAULT_TEXT_CUSTOM_SESSION_TTL_MINUTES = 30;
const DEFAULT_TEXT_SESSION_MAX_KB = 256;
const DEFAULT_TEXT_SESSION_CODE_LENGTH = 6;
const DEFAULT_TEXT_SESSION_MAX_SESSIONS = 500;
const DEFAULT_TEXT_SESSION_MAX_CLIENTS = 20;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = readPositiveInteger(env, "PORT", DEFAULT_PORT);
  const fileExpirationHours = readPositiveInteger(
    env,
    "FILE_EXPIRATION_HOURS",
    DEFAULT_FILE_EXPIRATION_HOURS,
  );
  const maxFileSizeMb = readPositiveInteger(
    env,
    "MAX_FILE_SIZE_MB",
    DEFAULT_MAX_FILE_SIZE_MB,
  );
  const uploadRateLimitMax = readPositiveInteger(
    env,
    "UPLOAD_RATE_LIMIT_MAX",
    DEFAULT_UPLOAD_RATE_LIMIT_MAX,
  );
  const r2StorageHardLimitGb = readPositiveInteger(
    env,
    "R2_STORAGE_HARD_LIMIT_GB",
    DEFAULT_R2_STORAGE_HARD_LIMIT_GB,
  );
  const uploadReservationTtlMinutes = readPositiveInteger(
    env,
    "UPLOAD_RESERVATION_TTL_MINUTES",
    DEFAULT_UPLOAD_RESERVATION_TTL_MINUTES,
  );
  const uploadsEnabled = readBoolean(env, "UPLOADS_ENABLED", true);
  const textSessionTtlHours = readPositiveInteger(
    env,
    "TEXT_SESSION_TTL_HOURS",
    DEFAULT_TEXT_SESSION_TTL_HOURS,
  );
  const textCustomSessionTtlMinutes = readPositiveInteger(
    env,
    "TEXT_CUSTOM_SESSION_TTL_MINUTES",
    DEFAULT_TEXT_CUSTOM_SESSION_TTL_MINUTES,
  );
  const textSessionMaxKb = readPositiveInteger(
    env,
    "TEXT_SESSION_MAX_KB",
    DEFAULT_TEXT_SESSION_MAX_KB,
  );
  const textSessionCodeLength = readPositiveInteger(
    env,
    "TEXT_SESSION_CODE_LENGTH",
    DEFAULT_TEXT_SESSION_CODE_LENGTH,
  );
  const textSessionMaxSessions = readPositiveInteger(
    env,
    "TEXT_SESSION_MAX_SESSIONS",
    DEFAULT_TEXT_SESSION_MAX_SESSIONS,
  );
  const textSessionMaxClientsPerSession = readPositiveInteger(
    env,
    "TEXT_SESSION_MAX_CLIENTS",
    DEFAULT_TEXT_SESSION_MAX_CLIENTS,
  );
  const publicBaseUrl = readRequired(env, "PUBLIC_BASE_URL").replace(/\/+$/, "");

  return {
    port,
    databaseUrl: readRequired(env, "DATABASE_URL"),
    r2AccountId: readRequired(env, "R2_ACCOUNT_ID"),
    r2AccessKeyId: readRequired(env, "R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: readRequired(env, "R2_SECRET_ACCESS_KEY"),
    r2BucketName: readOptional(env, "R2_BUCKET_NAME") ?? DEFAULT_R2_BUCKET_NAME,
    publicBaseUrl,
    fileExpirationHours,
    maxFileSizeMb,
    maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
    uploadRateLimitMax,
    uploadsEnabled,
    r2StorageHardLimitGb,
    r2StorageHardLimitBytes: r2StorageHardLimitGb * 1024 * 1024 * 1024,
    uploadReservationTtlMinutes,
    githubToken: readOptional(env, "QUICKDROP_GITHUB_TOKEN") ?? readOptional(env, "GITHUB_TOKEN"),
    githubReleaseRepository:
      readOptional(env, "QUICKDROP_GITHUB_REPOSITORY") ?? DEFAULT_GITHUB_RELEASE_REPOSITORY,
    textSessionTtlHours,
    textCustomSessionTtlMinutes,
    textSessionMaxBytes: textSessionMaxKb * 1024,
    textSessionCodeLength,
    textSessionMaxSessions,
    textSessionMaxClientsPerSession,
  };
}

function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = readOptional(env, name);

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readOptional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const rawValue = readOptional(env, name);

  if (!rawValue) {
    return fallback;
  }

  const normalized = rawValue.toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean`);
}

function readPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const rawValue = readOptional(env, name);

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}
