<script lang="ts">
  import CollapsibleItemSidebar from './CollapsibleItemSidebar.svelte';

  let { detailActive = false }: { detailActive?: boolean } = $props();
</script>

<div class="flex">
  <CollapsibleItemSidebar label="Test items" {detailActive}>
    <p>Sidebar contents</p>
    {#snippet detail()}
      <main>Main contents</main>
    {/snippet}
  </CollapsibleItemSidebar>
</div>
