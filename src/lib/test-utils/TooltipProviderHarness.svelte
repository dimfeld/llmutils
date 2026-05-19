<script lang="ts">
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import type { Component as SvelteComponent } from 'svelte';

  let {
    component: Component,
    props = {},
  }: {
    component: SvelteComponent;
    props?: Record<string, unknown>;
  } = $props();
</script>

<Tooltip.Provider delayDuration={0}>
  <Component {...props} />
</Tooltip.Provider>
