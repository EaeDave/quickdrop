import type { FastifyReply } from "fastify";
import type { AppConfig } from "./config";
import { handleReleaseAssetDownload } from "./github-release";

const WINDOWS_INSTALLER_ASSET_PATTERN = /^QuickDrop_.*_x64-setup\.exe$/;
const WINDOWS_QD_ASSET_PATTERN = /^qd_.*_x86_64-windows\.exe$/;
const WINDOWS_QD_CHECKSUM_ASSET_PATTERN = /^qd_.*_x86_64-windows\.exe\.sha256$/;

export async function handleWindowsInstallerDownload(
  reply: FastifyReply,
  { config }: { config: AppConfig },
): Promise<FastifyReply> {
  return handleReleaseAssetDownload(reply, {
    token: config.githubToken,
    repository: config.githubReleaseRepository,
    assetPattern: WINDOWS_INSTALLER_ASSET_PATTERN,
    assetNotFoundMessage:
      "No QuickDrop Windows x64 installer asset found in the latest GitHub release.",
  });
}

export async function handleWindowsQdDownload(
  reply: FastifyReply,
  { config }: { config: AppConfig },
): Promise<FastifyReply> {
  return handleReleaseAssetDownload(reply, {
    token: config.githubToken,
    repository: config.githubReleaseRepository,
    assetPattern: WINDOWS_QD_ASSET_PATTERN,
    assetNotFoundMessage: "No qd Windows x86_64 binary asset found in the latest GitHub release.",
  });
}

export async function handleWindowsQdChecksumDownload(
  reply: FastifyReply,
  { config }: { config: AppConfig },
): Promise<FastifyReply> {
  return handleReleaseAssetDownload(reply, {
    token: config.githubToken,
    repository: config.githubReleaseRepository,
    assetPattern: WINDOWS_QD_CHECKSUM_ASSET_PATTERN,
    assetNotFoundMessage:
      "No qd Windows x86_64 checksum asset found in the latest GitHub release.",
  });
}
