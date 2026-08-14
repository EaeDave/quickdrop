import type { FastifyReply } from "fastify";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_USER_AGENT = "quickdrop-installer-proxy";

type GitHubReleaseAsset = {
  name: string;
  size?: number;
  url: string;
};

type GitHubRelease = {
  assets?: GitHubReleaseAsset[];
};

export type ReleaseAssetDownloadOptions = {
  token: string | undefined;
  repository: string;
  assetPattern: RegExp;
  assetNotFoundMessage: string;
  releaseTag?: string;
};

export async function handleReleaseAssetDownload(
  reply: FastifyReply,
  options: ReleaseAssetDownloadOptions,
): Promise<FastifyReply> {
  const release = await fetchRelease(options.repository, options.token, options.releaseTag);
  if (!release.ok) {
    return reply
      .code(502)
      .type("text/plain; charset=utf-8")
      .send(`Could not resolve latest QuickDrop release from GitHub (${release.status}).`);
  }

  const asset = release.value.assets?.find((candidate) => options.assetPattern.test(candidate.name));
  if (!asset) {
    return reply.code(404).type("text/plain; charset=utf-8").send(options.assetNotFoundMessage);
  }
  if (asset.size === 0) {
    return reply
      .code(502)
      .type("text/plain; charset=utf-8")
      .send("GitHub returned an empty QuickDrop release asset.");
  }

  const download = await fetchReleaseAsset(asset.url, options.token);
  if (!download.ok) {
    return reply
      .code(502)
      .type("text/plain; charset=utf-8")
      .send(`Could not download QuickDrop release asset from GitHub (${download.status}).`);
  }

  if (!download.value.body || download.value.headers.get("content-length") === "0") {
    return reply
      .code(502)
      .type("text/plain; charset=utf-8")
      .send("GitHub returned an empty QuickDrop release asset response.");
  }

  reply
    .type(download.value.headers.get("content-type") ?? "application/octet-stream")
    .header("cache-control", "public, max-age=300")
    .header("content-disposition", `attachment; filename="${asset.name}"`);
  const contentLength = download.value.headers.get("content-length");
  if (contentLength) reply.header("content-length", contentLength);
  return reply.send(Readable.fromWeb(download.value.body as unknown as NodeReadableStream));
}

async function fetchRelease(
  repository: string,
  token: string | undefined,
  releaseTag?: string,
): Promise<{ ok: true; value: GitHubRelease } | { ok: false; status: number }> {
  const releasePath = releaseTag ? `releases/tags/${encodeURIComponent(releaseTag)}` : "releases/latest";
  const response = await fetch(`${GITHUB_API_BASE_URL}/repos/${repository}/${releasePath}`, {
    headers: githubHeaders(token, "application/vnd.github+json"),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  return { ok: true, value: (await response.json()) as GitHubRelease };
}

async function fetchReleaseAsset(
  assetApiUrl: string,
  token: string | undefined,
): Promise<{ ok: true; value: Response } | { ok: false; status: number }> {
  const response = await fetch(assetApiUrl, {
    headers: githubHeaders(token, "application/octet-stream"),
    signal: AbortSignal.timeout(5 * 60_000),
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  return { ok: true, value: response };
}

function githubHeaders(token: string | undefined, accept: string): HeadersInit {
  return {
    accept,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "user-agent": GITHUB_USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
  };
}
