<script lang="ts">
  import SessionDetail from './SessionDetail.svelte';
  import * as Tooltip from '$lib/components/ui/tooltip/index.js';
  import type { SessionData } from '$lib/types/session.js';

  let { session }: { session: SessionData } = $props();
</script>

<Tooltip.Provider delayDuration={500}>
  <SessionDetail {session} />
</Tooltip.Provider>
