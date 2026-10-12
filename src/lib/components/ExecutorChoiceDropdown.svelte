<script lang="ts">
  import type { ChatExecutorOption } from '$tim/configSchema.js';
  import {
    DEFAULT_CHAT_EXECUTOR_OPTIONS,
    chatExecutorLabel,
    chatOptionKey,
  } from '$lib/utils/chat_executor_options.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';

  let {
    label,
    options = DEFAULT_CHAT_EXECUTOR_OPTIONS,
    disabled = false,
    ariaLabel,
    buttonClass = '',
    onselect,
  }: {
    label: string;
    options?: ChatExecutorOption[];
    disabled?: boolean;
    ariaLabel: string;
    buttonClass?: string;
    onselect: (option: ChatExecutorOption) => void;
  } = $props();
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger {disabled}>
    {#snippet child({ props })}
      <button
        {...props}
        type="button"
        class={['inline-flex items-center gap-1', buttonClass]}
        aria-label={ariaLabel}
      >
        {label}
        <ChevronDownIcon class="size-3 opacity-70" />
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" sideOffset={4} class="min-w-44">
    {#each options as option (chatOptionKey(option))}
      <DropdownMenu.Item class="cursor-pointer" onclick={() => onselect(option)}>
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="truncate text-sm font-medium">{option.model ?? 'Default model'}</span>
          <span class="text-xs text-muted-foreground">{chatExecutorLabel(option.executor)}</span>
        </span>
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>
