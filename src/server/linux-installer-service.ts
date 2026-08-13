import type { FastifyReply } from "fastify";
import type { AppConfig } from "./config";
import { handleReleaseAssetDownload } from "./github-release";

const LINUX_BINARY_ASSET_PATTERN = /^quickdrop_.*_x86_64-linux$/;
const LINUX_QD_ASSET_PATTERN = /^qd_.*_x86_64-linux$/;
const LINUX_QD_CHECKSUM_ASSET_PATTERN = /^qd_.*_x86_64-linux\.sha256$/;

export async function handleLinuxInstallerDownload(
  reply: FastifyReply,
  { config }: { config: AppConfig },
): Promise<FastifyReply> {
  return handleReleaseAssetDownload(reply, {
    token: config.githubToken,
    repository: config.githubReleaseRepository,
    assetPattern: LINUX_BINARY_ASSET_PATTERN,
    assetNotFoundMessage:
      "No QuickDrop Linux x86_64 binary asset found in the latest GitHub release.",
  });
}

export async function handleLinuxQdDownload(
  reply: FastifyReply,
  { config }: { config: AppConfig },
): Promise<FastifyReply> {
  return handleReleaseAssetDownload(reply, {
    token: config.githubToken,
    repository: config.githubReleaseRepository,
    assetPattern: LINUX_QD_ASSET_PATTERN,
    assetNotFoundMessage: "No qd Linux x86_64 binary asset found in the latest GitHub release.",
  });
}

export async function handleLinuxQdChecksumDownload(
  reply: FastifyReply,
  { config }: { config: AppConfig },
): Promise<FastifyReply> {
  return handleReleaseAssetDownload(reply, {
    token: config.githubToken,
    repository: config.githubReleaseRepository,
    assetPattern: LINUX_QD_CHECKSUM_ASSET_PATTERN,
    assetNotFoundMessage:
      "No qd Linux x86_64 checksum asset found in the latest GitHub release.",
  });
}
