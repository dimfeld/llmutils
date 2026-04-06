import { describe, expect, test, vi } from 'vitest';
import { isTypingTarget, handleGlobalShortcuts } from './keyboard_shortcuts.js';

function makeKeyEvent(
  code: string,
  modifiers: {
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  } = {},
  target?: Partial<HTMLElement>
): KeyboardEvent {
  return {
    code,
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    altKey: modifiers.altKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    target: target ?? { tagName: 'DIV', isContentEditable: false },
    preventDefault: vi.fn(),
  } as unknown as KeyboardEvent;
}

describe('isTypingTarget', () => {
  test('returns true for INPUT elements', () => {
    const event = makeKeyEvent('Slash', {}, { tagName: 'INPUT', isContentEditable: false });
    expect(isTypingTarget(event)).toBe(true);
  });

  test('returns true for TEXTAREA elements', () => {
    const event = makeKeyEvent('Slash', {}, { tagName: 'TEXTAREA', isContentEditable: false });
    expect(isTypingTarget(event)).toBe(true);
  });

  test('returns true for SELECT elements', () => {
    const event = makeKeyEvent('Slash', {}, { tagName: 'SELECT', isContentEditable: false });
    expect(isTypingTarget(event)).toBe(true);
  });

  test('returns true for contenteditable elements', () => {
    const event = makeKeyEvent('Slash', {}, { tagName: 'DIV', isContentEditable: true });
    expect(isTypingTarget(event)).toBe(true);
  });

  test('returns false for regular DIV elements', () => {
    const event = makeKeyEvent('Slash', {}, { tagName: 'DIV', isContentEditable: false });
    expect(isTypingTarget(event)).toBe(false);
  });

  test('returns false for BUTTON elements', () => {
    const event = makeKeyEvent('Slash', {}, { tagName: 'BUTTON', isContentEditable: false });
    expect(isTypingTarget(event)).toBe(false);
  });

  test('returns false when target is null', () => {
    const event = { target: null } as unknown as KeyboardEvent;
    expect(isTypingTarget(event)).toBe(false);
  });
});

describe('handleGlobalShortcuts', () => {
  test('Cmd+K calls openCommandBar with current-project scope', () => {
    const openCommandBar = vi.fn();
    const event = makeKeyEvent('KeyK', { metaKey: true });

    handleGlobalShortcuts(event, { openCommandBar });

    expect(openCommandBar).toHaveBeenCalledWith(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  test('Ctrl+K calls openCommandBar with current-project scope', () => {
    const openCommandBar = vi.fn();
    const event = makeKeyEvent('KeyK', { ctrlKey: true });

    handleGlobalShortcuts(event, { openCommandBar });

    expect(openCommandBar).toHaveBeenCalledWith(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  test('Cmd+Shift+K calls openCommandBar with all-project scope', () => {
    const openCommandBar = vi.fn();
    const event = makeKeyEvent('KeyK', { metaKey: true, shiftKey: true });

    handleGlobalShortcuts(event, { openCommandBar });

    expect(openCommandBar).toHaveBeenCalledWith(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  test('Ctrl+Shift+K calls openCommandBar with all-project scope', () => {
    const openCommandBar = vi.fn();
    const event = makeKeyEvent('KeyK', { ctrlKey: true, shiftKey: true });

    handleGlobalShortcuts(event, { openCommandBar });

    expect(openCommandBar).toHaveBeenCalledWith(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  test('Cmd+K does not fire in typing targets', () => {
    const openCommandBar = vi.fn();
    const event = makeKeyEvent(
      'KeyK',
      { metaKey: true },
      { tagName: 'INPUT', isContentEditable: false }
    );

    handleGlobalShortcuts(event, { openCommandBar });

    expect(openCommandBar).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('Ctrl+/ calls focusSearch and prevents default when it returns true', () => {
    const focusSearch = vi.fn(() => true);
    const event = makeKeyEvent('Slash', { ctrlKey: true });
    handleGlobalShortcuts(event, { focusSearch });
    expect(focusSearch).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  test('Ctrl+/ calls focusSearch but does NOT prevent default when it returns false', () => {
    const focusSearch = vi.fn(() => false);
    const event = makeKeyEvent('Slash', { ctrlKey: true });
    handleGlobalShortcuts(event, { focusSearch });
    expect(focusSearch).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('Ctrl+/ in typing target does NOT call focusSearch', () => {
    const focusSearch = vi.fn(() => true);
    const event = makeKeyEvent(
      'Slash',
      { ctrlKey: true },
      { tagName: 'INPUT', isContentEditable: false }
    );
    handleGlobalShortcuts(event, { focusSearch });
    expect(focusSearch).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('Ctrl+/ in contenteditable does NOT call focusSearch', () => {
    const focusSearch = vi.fn(() => true);
    const event = makeKeyEvent(
      'Slash',
      { ctrlKey: true },
      { tagName: 'DIV', isContentEditable: true }
    );
    handleGlobalShortcuts(event, { focusSearch });
    expect(focusSearch).not.toHaveBeenCalled();
  });

  test('Ctrl+1 calls navigateTab with 1', () => {
    const navigateTab = vi.fn();
    const event = makeKeyEvent('Digit1', { ctrlKey: true });
    handleGlobalShortcuts(event, { navigateTab });
    expect(navigateTab).toHaveBeenCalledWith(1);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  test('Ctrl+2 calls navigateTab with 2', () => {
    const navigateTab = vi.fn();
    const event = makeKeyEvent('Digit2', { ctrlKey: true });
    handleGlobalShortcuts(event, { navigateTab });
    expect(navigateTab).toHaveBeenCalledWith(2);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  test('Ctrl+3 calls navigateTab with 3', () => {
    const navigateTab = vi.fn();
    const event = makeKeyEvent('Digit3', { ctrlKey: true });
    handleGlobalShortcuts(event, { navigateTab });
    expect(navigateTab).toHaveBeenCalledWith(3);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  test('Ctrl+1/2/3 fires even in typing targets', () => {
    const navigateTab = vi.fn();
    const event = makeKeyEvent(
      'Digit1',
      { ctrlKey: true },
      { tagName: 'INPUT', isContentEditable: false }
    );
    handleGlobalShortcuts(event, { navigateTab });
    expect(navigateTab).toHaveBeenCalledWith(1);
  });

  test('Ctrl+2 fires in textarea targets and prevents default', () => {
    const navigateTab = vi.fn();
    const event = makeKeyEvent(
      'Digit2',
      { ctrlKey: true },
      { tagName: 'TEXTAREA', isContentEditable: false }
    );
    handleGlobalShortcuts(event, { navigateTab });
    expect(navigateTab).toHaveBeenCalledWith(2);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  test('Ctrl+Shift+/ fires focusSearch (Shift modifier allowed)', () => {
    const focusSearch = vi.fn(() => true);
    const event = makeKeyEvent('Slash', { ctrlKey: true, shiftKey: true });
    handleGlobalShortcuts(event, { focusSearch });
    expect(focusSearch).toHaveBeenCalledOnce();
  });

  test('Ctrl+Shift+1 fires navigateTab (Shift modifier allowed)', () => {
    const navigateTab = vi.fn();
    const event = makeKeyEvent('Digit1', { ctrlKey: true, shiftKey: true });
    handleGlobalShortcuts(event, { navigateTab });
    expect(navigateTab).toHaveBeenCalledWith(1);
  });

  test('does nothing without Ctrl modifier', () => {
    const focusSearch = vi.fn();
    const navigateTab = vi.fn();
    const event = makeKeyEvent('Slash');
    handleGlobalShortcuts(event, { focusSearch, navigateTab });
    expect(focusSearch).not.toHaveBeenCalled();
    expect(navigateTab).not.toHaveBeenCalled();
  });

  test('Meta+/ does NOT trigger focusSearch', () => {
    const focusSearch = vi.fn();
    const event = makeKeyEvent('Slash', { metaKey: true });
    handleGlobalShortcuts(event, { focusSearch });
    expect(focusSearch).not.toHaveBeenCalled();
  });

  test('Ctrl+Meta+/ does NOT trigger (extra modifier)', () => {
    const focusSearch = vi.fn();
    const event = makeKeyEvent('Slash', { ctrlKey: true, metaKey: true });
    handleGlobalShortcuts(event, { focusSearch });
    expect(focusSearch).not.toHaveBeenCalled();
  });

  test('Ctrl+Alt+/ does NOT trigger (extra modifier)', () => {
    const focusSearch = vi.fn();
    const event = makeKeyEvent('Slash', { ctrlKey: true, altKey: true });
    handleGlobalShortcuts(event, { focusSearch });
    expect(focusSearch).not.toHaveBeenCalled();
  });

  test('Meta+1 does NOT trigger navigateTab', () => {
    const navigateTab = vi.fn();
    const event = makeKeyEvent('Digit1', { metaKey: true });
    handleGlobalShortcuts(event, { navigateTab });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('Ctrl+4 calls navigateTab with 4', () => {
    const navigateTab = vi.fn();
    const event = makeKeyEvent('Digit4', { ctrlKey: true });
    handleGlobalShortcuts(event, { navigateTab });
    expect(navigateTab).toHaveBeenCalledWith(4);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  test('Ctrl+Digit5 does NOT trigger navigateTab', () => {
    const navigateTab = vi.fn();
    const event = makeKeyEvent('Digit5', { ctrlKey: true });
    handleGlobalShortcuts(event, { navigateTab });
    expect(navigateTab).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('does nothing when no callbacks provided', () => {
    const event = makeKeyEvent('Slash', { ctrlKey: true });
    handleGlobalShortcuts(event, {});
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('does nothing when focusSearch callback missing for Ctrl+/', () => {
    const navigateTab = vi.fn();
    const event = makeKeyEvent('Slash', { ctrlKey: true });
    handleGlobalShortcuts(event, { navigateTab });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test('does nothing when navigateTab callback missing for Ctrl+1', () => {
    const focusSearch = vi.fn();
    const event = makeKeyEvent('Digit1', { ctrlKey: true });
    handleGlobalShortcuts(event, { focusSearch });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
