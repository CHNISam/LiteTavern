export function parsePublicOrigins(...values: Array<string | undefined>): string[] {
  const origins = new Set<string>();
  for (const raw of values) {
    for (const value of (raw ?? '').split(/[\s,]+/).filter(Boolean)) {
      try {
        const url = new URL(value);
        if (url.protocol === 'https:' || url.protocol === 'http:') origins.add(url.origin);
      } catch {
        // Public build variables are configuration, not user input. Invalid entries
        // are ignored here and remain unavailable at runtime.
      }
    }
  }
  return [...origins];
}
