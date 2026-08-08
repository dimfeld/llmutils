<script lang="ts">
  import type { SessionProcessNode } from '$lib/types/session.js';
  import { setSessionManager } from '$lib/stores/session_state.svelte.js';
  import ProcessTree from './ProcessTree.svelte';

  interface Props {
    processTree: SessionProcessNode[];
    connectionId?: string;
    sessionStatus?: 'active' | 'offline' | 'notification';
  }

  let { processTree, connectionId = 'conn-test', sessionStatus = 'active' }: Props = $props();

  setSessionManager();
</script>

<ProcessTree {processTree} {connectionId} {sessionStatus} />
