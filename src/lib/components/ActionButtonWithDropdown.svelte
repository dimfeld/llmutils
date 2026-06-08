<script lang="ts" module>
  export interface ActionItem {
    label: string;
    startingLabel: string;
    onclick: (event?: MouseEvent) => void;
    colorClass: string;
    starting: boolean;
  }
</script>

<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
  import Loader2Icon from '@lucide/svelte/icons/loader-2';

  let {
    primary,
    menuItems = [],
    disabled = false,
    size = 'sm' as const,
  }: {
    primary: ActionItem;
    menuItems?: ActionItem[];
    disabled?: boolean;
    size?: 'xs' | 'sm' | 'default';
  } = $props();

  let dropdownActions = $derived([primary, ...menuItems]);
</script>

{#if menuItems.length > 0}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      {#snippet child({ props })}
        <Button
          {...props}
          {disabled}
          {size}
          variant="outline"
          aria-label="Actions"
          class={size === 'xs' ? 'rounded' : ''}
        >
          Actions
          <ChevronDownIcon data-icon="inline-end" class="size-3.5 text-muted-foreground" />
        </Button>
      {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      align="end"
      sideOffset={6}
      class="min-w-44 rounded-lg border border-border/80 bg-popover p-1.5 shadow-xl ring-1 shadow-black/10 ring-black/5 dark:shadow-black/30"
    >
      {#each dropdownActions as item, index}
        <DropdownMenu.Item
          onclick={item.onclick}
          {disabled}
          class={[
            'cursor-pointer gap-2 rounded-md px-2.5 py-2 text-sm font-medium',
            'focus:bg-accent/80 data-highlighted:bg-accent/80',
            index === 0 ? 'bg-muted/60 text-foreground' : '',
          ]}
        >
          {#if item.starting}
            <Loader2Icon class="size-3.5 animate-spin text-muted-foreground" />
            <span>{item.startingLabel}</span>
          {:else}
            <span class="size-3.5"></span>
            <span>{item.label}</span>
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{:else}
  <Button
    onclick={primary.onclick}
    {disabled}
    {size}
    class={`${primary.colorClass} ${size === 'xs' ? 'rounded' : ''}`}
  >
    {#if primary.starting}
      <span
        class="inline-block animate-spin rounded-full border-2 border-white border-t-transparent {size ===
        'xs'
          ? 'h-2 w-2'
          : 'h-3 w-3'}"
      ></span>
      {primary.startingLabel}
    {:else}
      {primary.label}
    {/if}
  </Button>
{/if}
