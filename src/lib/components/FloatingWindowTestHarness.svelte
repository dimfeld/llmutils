<script lang="ts">
  import '../../routes/layout.css';
  import FloatingWindow from './FloatingWindow.svelte';
  import { SessionWindows } from '$lib/stores/session_windows.svelte.js';

  const windows = new SessionWindows();
</script>

<button onclick={() => windows.open('one')}>Open first session</button>
<button onclick={() => windows.open('two')}>Open second session</button>
<p>Page content</p>
{#each [...windows.windows.values()] as entry (entry.connectionId)}
  <FloatingWindow
    title={entry.connectionId}
    minimized={entry.minimized}
    layer={windows.order.indexOf(entry.connectionId)}
    onfocus={() => windows.focus(entry.connectionId)}
    onminimize={() => windows.minimize(entry.connectionId)}
    onclose={() => windows.close(entry.connectionId)}
  >
    <textarea aria-label="Draft {entry.connectionId}"></textarea>
  </FloatingWindow>
  {#if entry.minimized}<button onclick={() => windows.open(entry.connectionId)}
      >Restore {entry.connectionId}</button
    >{/if}
{/each}
