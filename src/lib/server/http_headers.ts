export function quoteHeaderValue(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`;
}
