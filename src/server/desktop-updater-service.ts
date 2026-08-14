import type { FastifyReply } from "fastify";
import type { AppConfig } from "./config";
import { handleReleaseAssetDownload } from "./github-release";

export type DesktopUpdatePlatform =
  | "linux-x86_64"
  | "windows-x86_64"
  | "darwin-aarch64"
  | "darwin-x86_64";

const PLATFORM_ASSET_NAMES: Record<DesktopUpdatePlatform, (version: string) => string> = {
  "linux-x86_64": (version) => `quickdrop_${version}_x86_64-linux`,
  "windows-x86_64": (version) => `QuickDrop_${version}_x64-setup.exe`,
  "darwin-aarch64": (version) => `QuickDrop_${version}_aarch64.app.tar.gz`,
  "darwin-x86_64": (version) => `QuickDrop_${version}_x64.app.tar.gz`,
};

export function isDesktopUpdatePlatform(value: string): value is DesktopUpdatePlatform {
  return Object.hasOwn(PLATFORM_ASSET_NAMES, value);
}

export async function handleDesktopUpdateManifestDownload(
  reply: FastifyReply,
  config: AppConfig,
): Promise<FastifyReply> {
  return handleReleaseAssetDownload(reply, {
    token: config.githubToken,
    repository: config.githubReleaseRepository,
    assetPattern: /^latest\.json$/,
    assetNotFoundMessage: "No Tauri updater manifest found in the latest GitHub release.",
  });
}

export async function handleDesktopUpdateDownload(
  reply: FastifyReply,
  config: AppConfig,
  version: string,
  platform: DesktopUpdatePlatform,
): Promise<FastifyReply> {
  const assetName = PLATFORM_ASSET_NAMES[platform](version);
  return handleReleaseAssetDownload(reply, {
    token: config.githubToken,
    repository: config.githubReleaseRepository,
    releaseTag: `v${version}`,
    assetPattern: new RegExp(`^${escapeRegExp(assetName)}$`),
    assetNotFoundMessage: `No ${platform} desktop updater found in QuickDrop v${version}.`,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
