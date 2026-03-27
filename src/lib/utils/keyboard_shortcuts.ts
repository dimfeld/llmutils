export interface ShortcutCallbacks {
  /** Return true if focus was successfully moved; preventDefault is only called when true. */
  focusSearch?: () => boolean;
  navigateTab?: (tabIndex: number) => void;
}

/** Returns true if the event target is a text-entry element where Ctrl+/ would type a character. */
export function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  const tagName = target.tagName;
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

const TAB_MAP: Record<string, number> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
};

/**
 * Handles global keyboard shortcuts using physical key codes for locale independence.
 * - Ctrl+/ → focusSearch (suppressed in typing targets)
 * - Ctrl+1/2/3 → navigateTab (always active)
 */
export function handleGlobalShortcuts(event: KeyboardEvent, callbacks: ShortcutCallbacks): void {
  if (!event.ctrlKey) return;
  if (event.metaKey || event.altKey) return;

  if (event.code === 'Slash' && callbacks.focusSearch) {
    if (isTypingTarget(event)) return;
    if (callbacks.focusSearch()) {
      event.preventDefault();
    }
    return;
  }

  const tabIndex = TAB_MAP[event.code];
  if (tabIndex && callbacks.navigateTab) {
    event.preventDefault();
    callbacks.navigateTab(tabIndex);
  }
}
