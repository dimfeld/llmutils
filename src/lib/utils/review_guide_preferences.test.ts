import { describe, expect, test } from 'vitest';
import {
  readReviewGuideVirtualizationPreference,
  writeReviewGuideVirtualizationPreference,
} from './review_guide_preferences.js';

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length(): number {
      return values.size;
    },
    clear(): void {
      values.clear();
    },
    getItem(key: string): string | null {
      return values.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      values.delete(key);
    },
    setItem(key: string, value: string): void {
      values.set(key, value);
    },
  };
}

describe('review guide preferences', () => {
  test('defaults virtualization to enabled', () => {
    expect(readReviewGuideVirtualizationPreference(createStorage())).toBe(true);
  });

  test('round-trips the disabled preference', () => {
    const storage = createStorage();

    writeReviewGuideVirtualizationPreference(storage, false);

    expect(readReviewGuideVirtualizationPreference(storage)).toBe(false);
  });
});
