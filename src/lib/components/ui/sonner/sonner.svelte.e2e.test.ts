import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { toast } from 'svelte-sonner';
import Toaster from './sonner.svelte';

afterEach(() => {
  toast.dismiss();
});

describe('Toaster', () => {
  test('closes a toast when it is clicked', async () => {
    render(Toaster);
    toast.success('Saved the plan');

    const message = page.getByText('Saved the plan');
    await expect.element(message).toBeVisible();

    await message.click();

    await expect.element(message).not.toBeInTheDocument();
  });

  test('runs a toast action without an additional close from the click handler', async () => {
    render(Toaster);
    let actionCalls = 0;
    toast('Plan updated', {
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: 'Undo',
        onClick: (event) => {
          event.preventDefault();
          actionCalls += 1;
        },
      },
    });

    await expect.element(page.getByText('Plan updated')).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();

    expect(actionCalls).toBe(1);
    await expect.element(page.getByText('Plan updated')).toBeVisible();
  });
});
