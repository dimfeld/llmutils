import { tick } from 'svelte';

/** Returns 'up' or 'down' if the event is Alt+ArrowUp/Down, otherwise null. */
export function isListNavEvent(event: KeyboardEvent): 'up' | 'down' | null {
  if (!event.altKey) return null;
  if (event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (event.key === 'ArrowUp') return 'up';
  if (event.key === 'ArrowDown') return 'down';
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
