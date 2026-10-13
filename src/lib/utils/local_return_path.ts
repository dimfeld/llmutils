/**
 * True when a value is a same-origin path that is safe to use as a return target: it starts
 * with one `/`, and it has no backslashes or control characters.
 */
export function isLocalReturnPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) {
    return false;
  }
  for (const char of value) {
    if (char === '\\' || char.charCodeAt(0) <= 0x1f) {
      return false;
    }
  }
  return true;
}
