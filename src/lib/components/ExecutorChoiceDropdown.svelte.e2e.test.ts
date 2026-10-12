import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import ExecutorChoiceDropdown from './ExecutorChoiceDropdown.svelte';

describe('ExecutorChoiceDropdown', () => {
  test('lists the configured options and reports the chosen one', async () => {
    const onselect = vi.fn();
    render(ExecutorChoiceDropdown, {
      props: {
        label: 'Fix Unresolved',
        ariaLabel: 'Fix all unresolved review threads',
        options: [
          { executor: 'claude-code', model: 'opus' },
          { executor: 'codex-cli', model: 'gpt-5-codex' },
          { executor: 'codex-cli' },
        ],
        onselect,
      },
    });

    await page.getByRole('button', { name: 'Fix all unresolved review threads' }).click();

    await expect.element(page.getByRole('menuitem', { name: /opus/ })).toBeVisible();
    await expect.element(page.getByRole('menuitem', { name: /Default model/ })).toBeVisible();

    await page.getByRole('menuitem', { name: /gpt-5-codex/ }).click();

    expect(onselect).toHaveBeenCalledTimes(1);
    expect(onselect).toHaveBeenCalledWith({ executor: 'codex-cli', model: 'gpt-5-codex' });
  });

  test('does not open the menu when disabled', async () => {
    const onselect = vi.fn();
    render(ExecutorChoiceDropdown, {
      props: {
        label: 'Session Active',
        ariaLabel: 'Fix all unresolved review threads',
        disabled: true,
        onselect,
      },
    });

    const trigger = page.getByRole('button', { name: 'Fix all unresolved review threads' });
    await expect.element(trigger).toBeDisabled();
    await expect.element(page.getByRole('menuitem')).not.toBeInTheDocument();
    expect(onselect).not.toHaveBeenCalled();
  });
});
