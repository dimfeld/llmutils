import { describe, expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import Harness from './FloatingWindowTestHarness.svelte';

describe('floating session windows', () => {
  test('minimize and restore preserve draft input and reopening reuses the window', async () => {
    render(Harness);
    await page.getByRole('button', { name: 'Open first session' }).click();
    await page.getByRole('textbox', { name: 'Draft one' }).fill('Explain this change');
    await page.getByRole('button', { name: 'Minimize one' }).click();
    await expect
      .element(page.getByRole('region', { name: 'one', exact: true, includeHidden: true }))
      .not.toBeVisible();
    await page.getByRole('button', { name: 'Restore one' }).click();
    await expect
      .element(page.getByRole('textbox', { name: 'Draft one' }))
      .toHaveValue('Explain this change');
    // The open action also restores an existing session, without a second content instance.
    await page.getByRole('button', { name: 'Minimize one' }).click();
    await page.getByRole('button', { name: 'Open first session' }).click();
    await expect
      .element(page.getByRole('textbox', { name: 'Draft one' }))
      .toHaveValue('Explain this change');
    await page.getByRole('button', { name: 'Close one' }).click();
    await expect
      .element(page.getByRole('region', { name: 'one', exact: true, includeHidden: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText('Page content')).toBeVisible();
  });

  test('keyboard controls move and resize the window', async () => {
    render(Harness);
    await page.getByRole('button', { name: 'Open first session' }).click();
    const panel = page
      .getByRole('region', { name: 'one', exact: true, includeHidden: true })
      .element() as HTMLElement;
    const before = panel.getBoundingClientRect();
    const initialHeight = panel.offsetHeight;
    // Make room to move even when the test viewport is narrower than the initial window.
    await page.getByRole('button', { name: 'Resize one' }).click();
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}');
    expect(panel.getBoundingClientRect().width).toBe(before.width - 1);
    expect(panel.getBoundingClientRect().height).toBe(initialHeight - 1);
    await page.getByRole('button', { name: 'Move one' }).click();
    await userEvent.keyboard('{ArrowRight}{ArrowDown}');
    expect(panel.getBoundingClientRect().left).toBe(before.left + 1);
    expect(panel.getBoundingClientRect().top).toBe(before.top + 1);
  });

  test('focus brings a session above other windows', async () => {
    render(Harness);
    await page.getByRole('button', { name: 'Open first session' }).click();
    await page.getByRole('button', { name: 'Minimize one' }).click();
    await page.getByRole('button', { name: 'Open second session' }).click();
    await page.getByRole('button', { name: 'Minimize two' }).click();
    await page.getByRole('button', { name: 'Restore one' }).click();
    const first = page
      .getByRole('region', { name: 'one', exact: true, includeHidden: true })
      .element() as HTMLElement;
    const second = page
      .getByRole('region', { name: 'two', exact: true, includeHidden: true })
      .element() as HTMLElement;
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex));
  });
});
