<script lang="ts">
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import Copy from '@lucide/svelte/icons/copy';

  type CopyState = 'idle' | 'copied' | 'failed';
  type CopyMode = 'icon' | 'text' | 'text-with-icon' | 'icon-with-text';

  interface Props {
    text?: string;
    mode?: CopyMode;
    label?: string;
    copiedLabel?: string;
    failedLabel?: string;
    timeoutMs?: number;
    disabled?: boolean;
    className?: string;
    idleClass?: string;
    copiedClass?: string;
    failedClass?: string;
    iconClass?: string;
    copiedIconClass?: string;
    failedIconClass?: string;
    title?: string;
    ariaLabel?: string;
    copyAction?: () => Promise<void> | void;
    onCopied?: () => void;
    onCopyError?: (message: string) => void;
  }

  let {
    text = '',
    mode = 'icon',
    label = 'Copy',
    copiedLabel = 'Copied',
    failedLabel = 'Failed',
    timeoutMs = 1500,
    disabled = false,
    className = '',
    idleClass = '',
    copiedClass = '',
    failedClass = '',
    iconClass: idleIconClassOverride = 'size-3',
    copiedIconClass: copiedIconClassOverride = 'text-emerald-600 dark:text-emerald-400',
    failedIconClass: failedIconClassOverride = 'text-red-600 dark:text-red-400',
    title = 'Copy',
    ariaLabel = 'Copy',
    copyAction,
    onCopied,
    onCopyError,
  }: Props = $props();

  let copyState = $state<CopyState>('idle');
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  async function handleCopy() {
    if (disabled) {
      return;
    }

    try {
      if (copyAction) {
        await copyAction();
      } else {
        await navigator.clipboard.writeText(text);
      }
      copyState = 'copied';
      onCopied?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      copyState = 'failed';
      onCopyError?.(message);
    }

    if (copyResetTimer) {
      clearTimeout(copyResetTimer);
    }
    copyResetTimer = setTimeout(() => {
      copyState = 'idle';
    }, timeoutMs);
  }

  function handleButtonClick(event: MouseEvent) {
    event.stopPropagation();
    void handleCopy();
  }

  let combinedClass = $derived.by(() => {
    const statusClass =
      copyState === 'copied' ? copiedClass : copyState === 'failed' ? failedClass : idleClass;
    return `${className} ${statusClass}`.trim();
  });

  let labelText = $derived.by(() => {
    if (copyState === 'copied') {
      return copiedLabel;
    }
    if (copyState === 'failed') {
      return failedLabel;
    }
    return label;
  });

  let idleIconClass = $derived.by(() => `size-3 shrink-0 ${idleIconClassOverride}`.trim());
  let copiedIconClass = $derived.by(() => `size-3 shrink-0 ${copiedIconClassOverride}`.trim());
  let failedIconClass = $derived.by(() => `size-3 shrink-0 ${failedIconClassOverride}`.trim());
</script>

<button
  type="button"
  {disabled}
  class={combinedClass}
  {title}
  aria-label={ariaLabel}
  onclick={handleButtonClick}
>
  {#if mode === 'text'}
    {labelText}
  {:else if mode === 'text-with-icon'}
    <span>{labelText}</span>
    {#if copyState === 'copied'}
      <CheckCircle class={copiedIconClass} />
    {:else}
      <Copy class={idleIconClass} />
    {/if}
  {:else if mode === 'icon-with-text'}
    {#if copyState === 'copied'}
      <CheckCircle class={copiedIconClass} />
    {:else}
      <Copy class={idleIconClass} />
    {/if}
    <span>{labelText}</span>
  {:else if copyState === 'copied'}
    <CheckCircle class={copiedIconClass} />
  {:else if copyState === 'failed'}
    <Copy class={failedIconClass} />
  {:else}
    <Copy class={idleIconClass} />
  {/if}
</button>
