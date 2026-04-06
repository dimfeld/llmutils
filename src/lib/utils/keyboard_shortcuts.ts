export interface ShortcutCallbacks {
  /** Return true if focus was successfully moved; preventDefault is only called when true. */
  focusSearch?: () => boolean;
  navigateTab?: (tabIndex: number) => void;
  openCommandBar?: (allProjects: boolean) => void;
  /** Called with 1-based index: 1 = all projects, 2+ = projects[index-2] */
  navigateProject?: (projectIndex: number) => void;
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

const DIGIT_MAP: Record<string, number> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
  Digit5: 5,
  Digit6: 6,
  Digit7: 7,
  Digit8: 8,
  Digit9: 9,
};

const TAB_DIGIT_MAX = 4;

/**
 * Handles global keyboard shortcuts using physical key codes for locale independence.
 * - Ctrl+/ → focusSearch (suppressed in typing targets)
 * - Ctrl+1/2/3/4 → navigateTab (always active)
 * - Cmd+1 → all projects, Cmd+2..9 → project by index (always active)
 */
export function handleGlobalShortcuts(event: KeyboardEvent, callbacks: ShortcutCallbacks): void {
  if (event.code === 'KeyK' && (event.metaKey || event.ctrlKey) && !event.altKey) {
    if (!callbacks.openCommandBar) return;

    event.preventDefault();
    callbacks.openCommandBar(event.shiftKey);
    return;
  }

  const digit = DIGIT_MAP[event.code];

  if (event.metaKey && !event.ctrlKey && !event.altKey && digit !== undefined) {
    if (callbacks.navigateProject) {
      event.preventDefault();
      callbacks.navigateProject(digit);
    }
    return;
  }

  if (!event.ctrlKey) return;
  if (event.metaKey || event.altKey) return;

  if (event.code === 'Slash' && callbacks.focusSearch) {
    if (isTypingTarget(event)) return;
    if (callbacks.focusSearch()) {
      event.preventDefault();
    }
    return;
  }

  if (digit !== undefined && digit <= TAB_DIGIT_MAX && callbacks.navigateTab) {
    event.preventDefault();
    callbacks.navigateTab(digit);
  }
}
