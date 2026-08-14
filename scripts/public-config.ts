const LOCAL_BASE_URLS = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);

export function publicBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  options: { allowLocal?: boolean } = {},
): string {
  const rawValue = env.QUICKDROP_PUBLIC_BASE_URL?.trim();
  if (!rawValue) {
    throw new Error("QUICKDROP_PUBLIC_BASE_URL is required");
  }

  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("QUICKDROP_PUBLIC_BASE_URL must be an absolute URL");
  }

  const normalized = url.origin;
  const isLocal = options.allowLocal === true && LOCAL_BASE_URLS.has(normalized);
  if (url.protocol !== "https:" && !isLocal) {
    throw new Error("QUICKDROP_PUBLIC_BASE_URL must use https:// (localhost is allowed for development)");
  }
  if (url.username || url.password) {
    throw new Error("QUICKDROP_PUBLIC_BASE_URL must not contain credentials");
  }
  if (!/^\/+$/u.test(url.pathname) || url.search || url.hash) {
    throw new Error("QUICKDROP_PUBLIC_BASE_URL must not contain a path, query, or fragment");
  }

  return normalized;
}

export function updaterBaseUrl(baseUrl: string): string {
  return `${baseUrl}/desktop/update`;
}
