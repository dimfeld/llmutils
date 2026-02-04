import type { TimConfig } from '../configSchema.js';

function normalizeList(values: string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  const normalized = values
    .map((value) => value?.toString().trim().toLowerCase())
    .filter((value): value is string => Boolean(value));

  const unique = Array.from(new Set(normalized));
  unique.sort();
  return unique;
}

export function normalizeTags(tags: string[] | undefined): string[] {
  return normalizeList(tags);
}

export function validateTags(tags: string[] | undefined, config?: TimConfig): string[] {
  const normalized = normalizeTags(tags);

  if (!normalized.length) {
    return [];
  }

  const allowlist = config?.tags;

  if (allowlist?.allowed !== undefined) {
    const allowedFromConfig = allowlist.allowed;
    const allowedSet = new Set(normalizeTags(allowedFromConfig));
    const invalid = normalized.filter((tag) => !allowedSet.has(tag));

    if (invalid.length > 0) {
      const messageParts = [`Invalid tag${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`];
      if (allowedFromConfig.length > 0) {
        messageParts.push(`Allowed tags: ${allowedFromConfig.join(', ')}`);
      } else {
        messageParts.push('No tags are currently allowed by configuration.');
      }
      throw new Error(messageParts.join('. '));
    }
  }

  return normalized;
}
