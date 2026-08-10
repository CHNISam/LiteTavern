/** Deep-copy data that is already constrained to a JSON wire/storage format. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
