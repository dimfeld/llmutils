<script lang="ts">
  import { Toaster as Sonner, type ToasterProps as SonnerProps } from 'svelte-sonner';
  import { mode } from 'mode-watcher';
  import Loader2Icon from '@lucide/svelte/icons/loader-2';
  import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
  import OctagonXIcon from '@lucide/svelte/icons/octagon-x';
  import InfoIcon from '@lucide/svelte/icons/info';
  import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

  let { toastOptions, ...restProps }: SonnerProps = $props();

  // svelte-sonner has no click-to-dismiss option. The Toaster renders a hidden
  // close button on each toast, and a click anywhere else on the toast triggers it.
  // Clicks on interactive content (action buttons, links, inputs) keep their own
  // behavior, and selecting text does not close the toast.
  function handleDocumentClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    const toastElement = event.target.closest('[data-sonner-toast]');
    if (!toastElement || toastElement.getAttribute('data-removed') === 'true') return;
    if (event.target.closest('button, a, input, select, textarea, [role="button"]')) return;
    if ((window.getSelection()?.toString().length ?? 0) > 0) return;

    toastElement.querySelector<HTMLButtonElement>(':scope > [data-close-button]')?.click();
  }
</script>

<svelte:document onclick={handleDocumentClick} />

<Sonner
  theme={mode.current}
  class="toaster group"
  closeButton
  toastOptions={{
    ...toastOptions,
    class: `cursor-pointer ${toastOptions?.class ?? ''}`,
    classes: { ...toastOptions?.classes, closeButton: 'hidden' },
  }}
  style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border);"
  {...restProps}
>
  {#snippet loadingIcon()}
    <Loader2Icon class="size-4 animate-spin" />
  {/snippet}
  {#snippet successIcon()}
    <CircleCheckIcon class="size-4" />
  {/snippet}
  {#snippet errorIcon()}
    <OctagonXIcon class="size-4" />
  {/snippet}
  {#snippet infoIcon()}
    <InfoIcon class="size-4" />
  {/snippet}
  {#snippet warningIcon()}
    <TriangleAlertIcon class="size-4" />
  {/snippet}
</Sonner>
