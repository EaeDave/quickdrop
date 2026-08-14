import type { FastifyReply } from "fastify";
import type { AppConfig } from "./config";
import { handleReleaseAssetDownload } from "./github-release";

export type MacOsArchitecture = "aarch64" | "x86_64";

function macOsQdAssetPattern(architecture: MacOsArchitecture): RegExp {
  return new RegExp(`^qd_.*_${architecture}-macos$`);
}

function macOsQdChecksumAssetPattern(architecture: MacOsArchitecture): RegExp {
  return new RegExp(`^qd_.*_${architecture}-macos\\.sha256$`);
}

export async function handleMacOsQdDownload(
  reply: FastifyReply,
  {
    config,
    architecture,
  }: { config: AppConfig; architecture: MacOsArchitecture },
): Promise<FastifyReply> {
  return handleReleaseAssetDownload(reply, {
    token: config.githubToken,
    repository: config.githubReleaseRepository,
    assetPattern: macOsQdAssetPattern(architecture),
    assetNotFoundMessage: `No qd macOS ${architecture} binary asset found in the latest GitHub release.`,
  });
}

export async function handleMacOsQdChecksumDownload(
  reply: FastifyReply,
  {
    config,
    architecture,
  }: { config: AppConfig; architecture: MacOsArchitecture },
): Promise<FastifyReply> {
  return handleReleaseAssetDownload(reply, {
    token: config.githubToken,
    repository: config.githubReleaseRepository,
    assetPattern: macOsQdChecksumAssetPattern(architecture),
    assetNotFoundMessage: `No qd macOS ${architecture} checksum asset found in the latest GitHub release.`,
  });
}
