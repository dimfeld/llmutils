<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Diff from '$lib/components/Diff.svelte';
  import { buildWholeFileDiff, type ReviewFileEntry } from '$lib/utils/review_guide_files.js';

  interface Props {
    entry: ReviewFileEntry;
    line: number | null;
    diffStyle: 'unified' | 'split';
    onClose: () => void;
  }

  let { entry, line, diffStyle, onClose }: Props = $props();

  let fileDiff = $derived(buildWholeFileDiff(entry));
  let label = $derived.by(() => {
    if (entry.row.kind === 'context') return 'Unchanged';
    switch (entry.row.changeType) {
      case 'added':
        return 'Added';
      case 'deleted':
        return 'Deleted';
      case 'renamed':
        return 'Renamed';
      default:
        return 'Modified';
    }
  });

  function findLineNode(root: ParentNode, lineNumber: number): HTMLElement | null {
    const selector = `[data-line="${lineNumber}"]`;
    const direct = root.querySelector(selector);
    if (direct instanceof HTMLElement) return direct;
    for (const host of root.querySelectorAll<HTMLElement>('diffs-container')) {
      const nested = host.shadowRoot?.querySelector(selector);
      if (nested instanceof HTMLElement) return nested;
    }
    return null;
  }

  /** Scroll the requested line into view once the diff has rendered. */
  function scrollToLineAttachment(node: HTMLElement) {
    const target = line;
    if (target == null) return;
    let attempts = 0;
    let frame = 0;
    const tryScroll = () => {
      const lineNode = findLineNode(node, target);
      if (lineNode) {
        lineNode.scrollIntoView({ block: 'center' });
        return;
      }
      attempts += 1;
      if (attempts < 60) frame = requestAnimationFrame(tryScroll);
    };
    frame = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(frame);
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape') onClose();
  }}
/>

<div
  class="fixed inset-y-0 right-0 z-40 flex w-[min(960px,92vw)] flex-col border-l border-border bg-background shadow-2xl"
  role="dialog"
  aria-label="File {entry.row.path}"
>
  <div class="flex items-center gap-2 border-b border-border px-4 py-2">
    <span
      class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
    >
      {label}
    </span>
    <span class="min-w-0 flex-1 truncate font-mono text-sm" title={entry.row.path}>
      {entry.row.path}{line != null ? `:${line}` : ''}
    </span>
    <button
      type="button"
      class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      onclick={onClose}
      aria-label="Close file"
    >
      <X class="size-4" />
    </button>
  </div>
  {#key `${entry.row.path}:${line}`}
    <div class="min-h-0 flex-1 overflow-y-auto p-3" {@attach scrollToLineAttachment}>
      {#if fileDiff}
        <Diff {fileDiff} {diffStyle} virtualize={false} disableFileHeader={true} />
      {:else}
        <p class="text-sm text-muted-foreground">The contents of this file were not stored.</p>
      {/if}
    </div>
  {/key}
</div>
