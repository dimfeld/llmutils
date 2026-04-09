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
    size?: 'sm' | 'default';
  } = $props();
</script>

{#if menuItems.length > 0}
  <ButtonGroup>
    <Button onclick={primary.onclick} {disabled} {size} class={primary.colorClass}>
      {#if primary.starting}
        <span
          class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
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
            size="icon-sm"
            aria-label="More actions"
            class={primary.colorClass}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
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
  <Button onclick={primary.onclick} {disabled} {size} class={primary.colorClass}>
    {#if primary.starting}
      <span
        class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent"
      ></span>
      {primary.startingLabel}
    {:else}
      {primary.label}
    {/if}
  </Button>
{/if}
