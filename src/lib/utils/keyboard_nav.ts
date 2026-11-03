import { tick } from 'svelte';

/** Returns 'up' or 'down' if the event is Alt+ArrowUp/Down, otherwise null. */
export function isListNavEvent(event: KeyboardEvent): 'up' | 'down' | null {
  if (!event.altKey) return null;
  if (event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === 'ArrowUp') return 'up';
  if (event.key === 'ArrowDown') return 'down';
  return null;
}

/** Returns 'up' or 'down' if the event is Alt+Shift+ArrowUp/Down, otherwise null. */
export function isMatchingListNavEvent(event: KeyboardEvent): 'up' | 'down' | null {
  if (!event.altKey || !event.shiftKey) return null;
  if (event.ctrlKey || event.metaKey) return null;
  if (event.key === 'ArrowUp') return 'up';
  if (event.key === 'ArrowDown') return 'down';
  return null;
}

/**
 * Like getAdjacentItem, but skips items that do not match the predicate. Returns the nearest
 * matching item in the given direction from the current item, or null if there is none.
 * If currentId is null or not found, returns the first (down) or last (up) matching item.
 */
export function getAdjacentMatchingItem(
  items: string[],
  currentId: string | null,
  direction: 'up' | 'down',
  matches: (id: string) => boolean
): string | null {
  const currentIndex = currentId === null ? -1 : items.indexOf(currentId);
  const step = direction === 'down' ? 1 : -1;
  let index =
    currentIndex === -1 ? (direction === 'down' ? 0 : items.length - 1) : currentIndex + step;

  while (index >= 0 && index < items.length) {
    if (matches(items[index])) return items[index];
    index += step;
  }

  return null;
}

/**
 * Given an ordered list of item IDs, the currently selected ID, and a direction,
 * returns the adjacent item ID, or null if at boundary or list is empty.
 * If currentId is null or not found, returns first (down) or last (up) item.
 */
export function getAdjacentItem(
  items: string[],
  currentId: string | null,
  direction: 'up' | 'down'
): string | null {
  if (items.length === 0) return null;

  if (currentId === null) {
    return direction === 'down' ? items[0] : items[items.length - 1];
  }

  const currentIndex = items.indexOf(currentId);
  if (currentIndex === -1) {
    return direction === 'down' ? items[0] : items[items.length - 1];
  }

  const nextIndex = direction === 'down' ? currentIndex + 1 : currentIndex - 1;
  if (nextIndex < 0 || nextIndex >= items.length) return null;

  return items[nextIndex];
}

/** Scrolls the element with the given data-list-item-id into view after a tick. */
export async function scrollListItemIntoView(itemId: string): Promise<void> {
  await tick();
  const element = document.querySelector(`[data-list-item-id="${CSS.escape(itemId)}"]`);
  element?.scrollIntoView({ block: 'nearest' });
}
