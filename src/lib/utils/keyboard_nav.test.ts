import { afterEach, describe, expect, test, vi } from 'vitest';
import { isListNavEvent, getAdjacentItem, scrollListItemIntoView } from './keyboard_nav.js';

function makeKeyEvent(
  key: string,
  modifiers: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {}
): KeyboardEvent {
  return {
    key,
    altKey: modifiers.altKey ?? false,
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
  } as unknown as KeyboardEvent;
}

describe('isListNavEvent', () => {
  test('returns "down" for Alt+ArrowDown', () => {
    expect(isListNavEvent(makeKeyEvent('ArrowDown', { altKey: true }))).toBe('down');
  });

  test('returns "up" for Alt+ArrowUp', () => {
    expect(isListNavEvent(makeKeyEvent('ArrowUp', { altKey: true }))).toBe('up');
  });

  test('returns null for plain ArrowDown', () => {
    expect(isListNavEvent(makeKeyEvent('ArrowDown'))).toBe(null);
  });

  test('returns null for plain ArrowUp', () => {
    expect(isListNavEvent(makeKeyEvent('ArrowUp'))).toBe(null);
  });

  test('returns null for Ctrl+ArrowDown', () => {
    expect(isListNavEvent(makeKeyEvent('ArrowDown', { ctrlKey: true }))).toBe(null);
  });

  test('returns null when Alt is combined with other modifiers', () => {
    expect(isListNavEvent(makeKeyEvent('ArrowDown', { altKey: true, ctrlKey: true }))).toBe(null);
    expect(isListNavEvent(makeKeyEvent('ArrowUp', { altKey: true, metaKey: true }))).toBe(null);
    expect(isListNavEvent(makeKeyEvent('ArrowDown', { altKey: true, shiftKey: true }))).toBe(null);
  });

  test('returns null for Alt+other key', () => {
    expect(isListNavEvent(makeKeyEvent('ArrowLeft', { altKey: true }))).toBe(null);
    expect(isListNavEvent(makeKeyEvent('Enter', { altKey: true }))).toBe(null);
  });
});

describe('getAdjacentItem', () => {
  const items = ['a', 'b', 'c', 'd'];

  test('returns next item going down', () => {
    expect(getAdjacentItem(items, 'b', 'down')).toBe('c');
  });

  test('returns previous item going up', () => {
    expect(getAdjacentItem(items, 'c', 'up')).toBe('b');
  });

  test('returns null at end boundary going down', () => {
    expect(getAdjacentItem(items, 'd', 'down')).toBe(null);
  });

  test('returns null at start boundary going up', () => {
    expect(getAdjacentItem(items, 'a', 'up')).toBe(null);
  });

  test('returns first item when currentId is null and direction is down', () => {
    expect(getAdjacentItem(items, null, 'down')).toBe('a');
  });

  test('returns last item when currentId is null and direction is up', () => {
    expect(getAdjacentItem(items, null, 'up')).toBe('d');
  });

  test('returns first item when currentId is not in list and direction is down', () => {
    expect(getAdjacentItem(items, 'z', 'down')).toBe('a');
  });

  test('returns last item when currentId is not in list and direction is up', () => {
    expect(getAdjacentItem(items, 'z', 'up')).toBe('d');
  });

  test('returns null for empty list', () => {
    expect(getAdjacentItem([], null, 'down')).toBe(null);
    expect(getAdjacentItem([], 'a', 'up')).toBe(null);
  });

  test('returns null for single item when already selected', () => {
    expect(getAdjacentItem(['a'], 'a', 'down')).toBe(null);
    expect(getAdjacentItem(['a'], 'a', 'up')).toBe(null);
  });

  test('returns single item when nothing selected', () => {
    expect(getAdjacentItem(['a'], null, 'down')).toBe('a');
    expect(getAdjacentItem(['a'], null, 'up')).toBe('a');
  });
});

describe('scrollListItemIntoView', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('queries the escaped data-list-item-id selector and scrolls the item into view', async () => {
    const scrollIntoView = vi.fn();
    const querySelector = vi.fn().mockReturnValue({ scrollIntoView });
    const escape = vi.fn((value: string) => `escaped:${value.replaceAll('"', '\\"')}`);

    vi.stubGlobal('document', { querySelector });
    vi.stubGlobal('CSS', { escape });

    await scrollListItemIntoView('plan"1');

    expect(escape).toHaveBeenCalledWith('plan"1');
    expect(querySelector).toHaveBeenCalledWith('[data-list-item-id="escaped:plan\\"1"]');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  test('does nothing when the item is not found', async () => {
    const querySelector = vi.fn().mockReturnValue(null);

    vi.stubGlobal('document', { querySelector });
    vi.stubGlobal('CSS', { escape: (value: string) => value });

    await expect(scrollListItemIntoView('missing')).resolves.toBeUndefined();
    expect(querySelector).toHaveBeenCalledWith('[data-list-item-id="missing"]');
  });
});
