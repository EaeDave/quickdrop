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
  githubToken: string | undefined;
  githubReleaseRepository: string;
};

const DEFAULT_PORT = 3000;
const DEFAULT_R2_BUCKET_NAME = "quickdrop";
const DEFAULT_FILE_EXPIRATION_HOURS = 24;
const DEFAULT_MAX_FILE_SIZE_MB = 500;
const DEFAULT_GITHUB_RELEASE_REPOSITORY = "EaeDave/quickdrop";

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
    githubToken: readOptional(env, "QUICKDROP_GITHUB_TOKEN") ?? readOptional(env, "GITHUB_TOKEN"),
    githubReleaseRepository:
      readOptional(env, "QUICKDROP_GITHUB_REPOSITORY") ?? DEFAULT_GITHUB_RELEASE_REPOSITORY,
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
