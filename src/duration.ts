const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Parses `90s`, `10m`, `2h` or `7d` into seconds. Returns null for anything else. */
export function parseDuration(value: string): number | null {
  const match = /^(\d{1,6})([smhd])$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * UNITS[match[2]!]!;
}

/** The shortest of `7d`, `2h`, `10m`, `90s` that is exact. */
export function formatDuration(seconds: number): string {
  for (const unit of ["d", "h", "m"] as const) {
    if (seconds > 0 && seconds % UNITS[unit]! === 0) return `${seconds / UNITS[unit]!}${unit}`;
  }
  return `${seconds}s`;
}

/** A rough, human length for Slack and the status page: `42m`, `3h 5m`, `2d 4h`. */
export function humanDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}
