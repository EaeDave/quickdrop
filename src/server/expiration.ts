export function computeExpiresAt(createdAt: Date, fileExpirationHours: number): Date {
  return new Date(createdAt.getTime() + fileExpirationHours * 60 * 60 * 1000);
}

export function computeSignedUrlExpirySeconds(expiresAt: Date, now: Date): number {
  return Math.max(1, Math.min(3600, Math.floor((expiresAt.getTime() - now.getTime()) / 1000)));
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
