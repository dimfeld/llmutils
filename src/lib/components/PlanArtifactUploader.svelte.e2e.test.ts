import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/navigation', () => ({
  invalidateAll: vi.fn(),
}));

vi.mock('svelte-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import PlanArtifactUploader from './PlanArtifactUploader.svelte';

function jsonResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PlanArtifactUploader checkbox (browser)', () => {
  test('Reference artifact checkbox is present and checked by default', async () => {
    render(PlanArtifactUploader, {
      props: { planUuid: 'plan-uuid', projectId: '123' },
    });

    const checkbox = page.getByTestId('artifact-reference-checkbox');
    await expect.element(checkbox).toBeInTheDocument();
    expect((checkbox.element() as HTMLInputElement).checked).toBe(true);
  });
});

describe('PlanArtifactUploader upload wiring (browser, fetch intercepted)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof window.fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
    fetchSpy = vi.fn(async () => jsonResponse());
    window.fetch = fetchSpy as unknown as typeof window.fetch;
  });

  afterEach(() => {
    window.fetch = originalFetch;
  });

  async function postedMessages(): Promise<Array<string | null>> {
    return fetchSpy.mock.calls.map(([, init]) => {
      const body = (init as RequestInit).body as FormData;
      return body.get('message') as string | null;
    });
  }

  test('the reference box (checked by default) wraps the posted message with the tim-reference: prefix', async () => {
    render(PlanArtifactUploader, {
      props: { planUuid: 'plan-uuid', projectId: '123' },
    });

    await page.getByTestId('artifact-message-input').fill('my notes');

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await page.getByTestId('artifact-file-input').upload(file);

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/artifacts');
    const body = (init as RequestInit).body as FormData;
    expect(body.get('message')).toBe('tim-reference:my notes');
    expect(body.get('planUuid')).toBe('plan-uuid');
  });

  test('unchecking the reference box posts the message unwrapped', async () => {
    render(PlanArtifactUploader, {
      props: { planUuid: 'plan-uuid', projectId: '123' },
    });

    await page.getByTestId('artifact-reference-checkbox').click();
    await page.getByTestId('artifact-message-input').fill('plain note');

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    await page.getByTestId('artifact-file-input').upload(file);

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    const [, init] = fetchSpy.mock.calls[0];
    const body = (init as RequestInit).body as FormData;
    expect(body.get('message')).toBe('plain note');
  });

  test('selecting multiple files with the reference box checked marks every posted request as a reference artifact', async () => {
    // The component snapshots the message/reference state once per batch in handleFiles, so a
    // multi-file selection should not let later files "lose" the reference marker even though
    // each file triggers its own sequential fetch call.
    render(PlanArtifactUploader, {
      props: { planUuid: 'plan-uuid', projectId: '123' },
    });

    const fileA = new File(['a'], 'a.txt', { type: 'text/plain' });
    const fileB = new File(['b'], 'b.txt', { type: 'text/plain' });
    await page.getByTestId('artifact-file-input').upload([fileA, fileB]);

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    const messages = await postedMessages();
    expect(messages).toEqual(['tim-reference:', 'tim-reference:']);
  });
});
