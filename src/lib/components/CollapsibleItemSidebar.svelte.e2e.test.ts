import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import CollapsibleItemSidebarTestHost from './CollapsibleItemSidebarTestHost.svelte';

test('starts expanded and can collapse and expand again', async () => {
  render(CollapsibleItemSidebarTestHost);

  const sidebarContents = page.getByText('Sidebar contents');
  await expect.element(sidebarContents).toBeVisible();
  await expect.element(page.getByText('Main contents')).toBeVisible();

  await page.getByRole('button', { name: 'Collapse Test items' }).click();
  await expect.element(sidebarContents).not.toBeInTheDocument();
  await expect.element(page.getByText('Main contents')).toBeVisible();

  await page.getByRole('button', { name: 'Expand Test items' }).click();
  await expect.element(sidebarContents).toBeVisible();
});

test('shows the mobile back bar only when a detail item is active', async () => {
  const { rerender } = render(CollapsibleItemSidebarTestHost, { detailActive: false });

  await expect
    .element(page.getByRole('button', { name: 'Back to Test items' }))
    .not.toBeInTheDocument();

  await rerender({ detailActive: true });
  // The back bar is in the DOM at every viewport width; CSS hides it on wide screens.
  await expect
    .element(page.getByRole('button', { name: 'Back to Test items' }))
    .toBeInTheDocument();
});
