<script lang="ts">
  import type { ChatExecutorOption } from '$tim/configSchema.js';
  import { ClaudeCodeExecutorName } from '$tim/executors/schemas.js';
  import { chatExecutorLabel, chatOptionKey } from '$lib/utils/chat_executor_options.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import Loader2Icon from '@lucide/svelte/icons/loader-2';

  let {
    open,
    options,
    startingKey,
    onOpenChange,
    onselect,
  }: {
    open: boolean;
    options: ChatExecutorOption[];
    /** Key of the option that is starting, from chatOptionKey, or false when idle. */
    startingKey: string | false;
    onOpenChange: (open: boolean) => void;
    onselect: (option: ChatExecutorOption) => void;
  } = $props();

  interface OptionGroup {
    executor: ChatExecutorOption['executor'];
    entries: { option: ChatExecutorOption; shortcut: number }[];
  }

  // Group by executor in order of first appearance. Shortcuts follow the displayed order so
  // the numbers read top to bottom.
  let groups = $derived.by((): OptionGroup[] => {
    const byExecutor = new Map<ChatExecutorOption['executor'], ChatExecutorOption[]>();
    for (const option of options) {
      const list = byExecutor.get(option.executor) ?? [];
      list.push(option);
      byExecutor.set(option.executor, list);
    }
    let shortcut = 0;
    return [...byExecutor].map(([executor, list]) => ({
      executor,
      entries: list.map((option) => ({ option, shortcut: ++shortcut })),
    }));
  });
  let displayedOptions = $derived(groups.flatMap((group) => group.entries.map((e) => e.option)));

  function handleKeydown(event: KeyboardEvent): void {
    if (startingKey || event.altKey || event.ctrlKey || event.metaKey || event.repeat) {
      return;
    }
    if (!/^[1-9]$/.test(event.key)) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input, textarea, select, [contenteditable="true"]')
    ) {
      return;
    }

    const option = displayedOptions[Number(event.key) - 1];
    if (!option) return;
    event.preventDefault();
    onselect(option);
  }

  function executorDotClass(executor: ChatExecutorOption['executor']): string {
    return executor === ClaudeCodeExecutorName ? 'bg-orange-500' : 'bg-sky-500';
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={(next) => {
    if (!next && startingKey) return;
    onOpenChange(next);
  }}
>
  <Dialog.Content class="gap-3 sm:max-w-md" onkeydown={handleKeydown}>
    <Dialog.Header>
      <Dialog.Title>Start Chat Session</Dialog.Title>
      <Dialog.Description>Choose a model. Press its number to start quickly.</Dialog.Description>
    </Dialog.Header>
    <div class="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
      {#each groups as group (group.executor)}
        <section class="flex flex-col gap-1" aria-label={chatExecutorLabel(group.executor)}>
          <h3
            class="flex items-center gap-2 px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
          >
            <span class={['size-1.5 rounded-full', executorDotClass(group.executor)]}></span>
            {chatExecutorLabel(group.executor)}
          </h3>
          <div class="overflow-hidden rounded-lg border border-border">
            {#each group.entries as { option, shortcut } (chatOptionKey(option))}
              {@const isStarting = startingKey === chatOptionKey(option)}
              <button
                type="button"
                onclick={() => onselect(option)}
                disabled={!!startingKey}
                aria-label={`${option.model ?? 'Default model'}, ${chatExecutorLabel(option.executor)}`}
                class={[
                  'group flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                  'not-first:border-t not-first:border-border',
                  'hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                  'disabled:cursor-not-allowed',
                  isStarting ? 'bg-accent' : 'disabled:opacity-50',
                ]}
              >
                <span
                  class={[
                    'min-w-0 flex-1 truncate text-sm',
                    option.model ? 'font-medium text-foreground' : 'text-muted-foreground italic',
                  ]}
                >
                  {option.model ?? 'Default model'}
                </span>
                {#if isStarting}
                  <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2Icon class="size-3.5 animate-spin" />
                    Starting…
                  </span>
                {:else if shortcut <= 9}
                  <kbd
                    class="flex size-5 items-center justify-center rounded border border-border bg-muted font-mono text-[11px] text-muted-foreground group-hover:bg-background"
                  >
                    {shortcut}
                  </kbd>
                {/if}
              </button>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
