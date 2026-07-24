import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import CollapsibleItemSidebarTestHost from './CollapsibleItemSidebarTestHost.svelte';

test('starts expanded and can collapse and expand again', async () => {
  render(CollapsibleItemSidebarTestHost);

  const sidebarContents = page.getByText('Sidebar contents');
  await expect.element(sidebarContents).toBeVisible();

  await page.getByRole('button', { name: 'Collapse Test items' }).click();
  await expect.element(sidebarContents).not.toBeInTheDocument();

  await page.getByRole('button', { name: 'Expand Test items' }).click();
  await expect.element(sidebarContents).toBeVisible();
});
