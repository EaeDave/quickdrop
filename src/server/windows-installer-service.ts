import type { FastifyReply } from "fastify";
import type { AppConfig } from "./config";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_USER_AGENT = "quickdrop-installer-proxy";
const WINDOWS_INSTALLER_ASSET_PATTERN = /^QuickDrop_.*_x64-setup\.exe$/;

type GitHubReleaseAsset = {
  name: string;
  url: string;
};

type GitHubRelease = {
  assets?: GitHubReleaseAsset[];
};

export async function handleWindowsInstallerDownload(
  reply: FastifyReply,
  { config }: { config: AppConfig },
): Promise<FastifyReply> {
  if (!config.githubToken) {
    return reply
      .code(503)
      .type("text/plain; charset=utf-8")
      .send("QuickDrop server is missing QUICKDROP_GITHUB_TOKEN or GITHUB_TOKEN.");
  }

  const release = await fetchLatestRelease(config.githubReleaseRepository, config.githubToken);
  if (!release.ok) {
    return reply
      .code(502)
      .type("text/plain; charset=utf-8")
      .send(`Could not resolve latest QuickDrop release from GitHub (${release.status}).`);
  }

  const asset = release.value.assets?.find((candidate) => WINDOWS_INSTALLER_ASSET_PATTERN.test(candidate.name));
  if (!asset) {
    return reply
      .code(404)
      .type("text/plain; charset=utf-8")
      .send("No QuickDrop Windows x64 installer asset found in the latest GitHub release.");
  }

  const installer = await fetchInstallerAsset(asset.url, config.githubToken);
  if (!installer.ok) {
    return reply
      .code(502)
      .type("text/plain; charset=utf-8")
      .send(`Could not download QuickDrop installer asset from GitHub (${installer.status}).`);
  }

  const installerBytes = Buffer.from(await installer.value.arrayBuffer());

  return reply
    .type(installer.value.headers.get("content-type") ?? "application/octet-stream")
    .header("cache-control", "public, max-age=300")
    .header("content-disposition", `attachment; filename="${asset.name}"`)
    .header("content-length", String(installerBytes.byteLength))
    .send(installerBytes);
}

async function fetchLatestRelease(
  repository: string,
  token: string,
): Promise<{ ok: true; value: GitHubRelease } | { ok: false; status: number }> {
  const response = await fetch(`${GITHUB_API_BASE_URL}/repos/${repository}/releases/latest`, {
    headers: githubHeaders(token, "application/vnd.github+json"),
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  return { ok: true, value: (await response.json()) as GitHubRelease };
}

async function fetchInstallerAsset(
  assetApiUrl: string,
  token: string,
): Promise<{ ok: true; value: Response } | { ok: false; status: number }> {
  const response = await fetch(assetApiUrl, {
    headers: githubHeaders(token, "application/octet-stream"),
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  return { ok: true, value: response };
}

function githubHeaders(token: string, accept: string): HeadersInit {
  return {
    accept,
    authorization: `Bearer ${token}`,
    "user-agent": GITHUB_USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
  };
}
