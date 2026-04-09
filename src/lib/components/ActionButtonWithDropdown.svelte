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
  import { ButtonGroup } from '$lib/components/ui/button-group/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';

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
</script>

{#if menuItems.length > 0}
  <ButtonGroup class={size === 'xs' ? 'rounded' : ''}>
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
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            {disabled}
            size={size === 'xs' ? 'icon-xs' : size === 'sm' ? 'icon-sm' : 'icon'}
            aria-label="More actions"
            class={`${primary.colorClass} ${size === 'xs' ? 'rounded' : ''}`}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width={size === 'xs' ? '12' : '16'}
              height={size === 'xs' ? '12' : '16'}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        {#each menuItems as item}
          <DropdownMenu.Item onclick={item.onclick} {disabled}>
            {item.starting ? item.startingLabel : item.label}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </ButtonGroup>
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
