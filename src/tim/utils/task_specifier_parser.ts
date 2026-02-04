/**
 * Parses a task specifier string like "1-3,5,7" into a sorted array of unique zero-based indices.
 * - Supports single numbers and ranges (start-end)
 * - Uses one-based indexing in input; returns zero-based in output
 * - Provides clear errors for malformed input
 */
export function parseTaskSpecifier(input: string): number[] {
  if (input == null) {
    throw new Error('Task specifier is required');
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error('Task specifier cannot be empty');
  }

  const indices = new Set<number>();

  // Split by commas and validate there are no empty segments
  const parts = trimmed.split(',');
  for (let rawPart of parts) {
    const part = rawPart.trim();
    if (part.length === 0) {
      throw new Error('Malformed task specifier: contains empty segment (e.g., repeated commas)');
    }

    // Range like 1-5 (allow spaces around '-')
    const rangeMatch = part.match(/^([0-9]+)\s*-\s*([0-9]+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start <= 0 || end <= 0) {
        throw new Error('Task indices must be positive integers (1-based)');
      }
      if (start > end) {
        throw new Error(`Invalid range '${part}': start must be <= end`);
      }
      for (let i = start; i <= end; i++) {
        indices.add(i - 1);
      }
      continue;
    }

    // Single number
    const singleMatch = part.match(/^\d+$/);
    if (singleMatch) {
      const value = parseInt(part, 10);
      if (value <= 0) {
        throw new Error('Task indices must be positive integers (1-based)');
      }
      indices.add(value - 1);
      continue;
    }

    // If it wasn't a range or a single number, it's malformed
    throw new Error(`Malformed task specifier segment: '${part}'`);
  }

  return Array.from(indices).sort((a, b) => a - b);
}
