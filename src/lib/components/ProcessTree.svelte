<script lang="ts">
  import SquareTerminal from '@lucide/svelte/icons/square-terminal';
  import Cpu from '@lucide/svelte/icons/cpu';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import Loader from '@lucide/svelte/icons/loader-circle';
  import { toast } from 'svelte-sonner';

  import type { SessionProcessNode, SessionExecutorTerminationResult } from '$lib/types/session.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import {
    buildProcessTree,
    flattenTree,
    formatElapsedTime,
    processStateLabel,
    processKindLabel,
    canTerminate,
    classifyTerminationStatus,
    terminationStatusMessage,
    type ProcessTreeNode,
  } from './process_tree.js';

  interface Props {
    processTree: SessionProcessNode[];
    connectionId: string;
    sessionStatus: 'active' | 'offline' | 'notification';
  }

  let { processTree, connectionId, sessionStatus }: Props = $props();
  const sessionManager = useSessionManager();

  let roots = $derived(buildProcessTree(processTree));
  let flatNodes = $derived(flattenTree(roots));

  interface TerminationState {
    confirming: boolean;
    pending: boolean;
    result: SessionExecutorTerminationResult | null;
  }

  let terminationStates = $state(new Map<string, TerminationState>());

  function getTerminationState(processId: string): TerminationState | undefined {
    return terminationStates.get(processId);
  }

  function requestTerminate(processId: string): void {
    const newMap = new Map(terminationStates);
    newMap.set(processId, { confirming: true, pending: false, result: null });
    terminationStates = newMap;
  }

  function cancelTerminate(processId: string): void {
    const newMap = new Map(terminationStates);
    newMap.delete(processId);
    terminationStates = newMap;
  }

  async function confirmTerminate(processId: string): Promise<void> {
    const current = terminationStates.get(processId);
    if (current?.pending) return;

    const newMap = new Map(terminationStates);
    newMap.set(processId, { confirming: false, pending: true, result: null });
    terminationStates = newMap;

    const result = await sessionManager.terminateExecutor(connectionId, processId);

    const outcome = classifyTerminationStatus(result.status);
    const message = terminationStatusMessage(result.status);

    if (outcome === 'success') {
      toast.success(message);
    } else if (outcome === 'stale') {
      toast.warning(message);
    } else {
      toast.error(message);
    }

    const updatedMap = new Map(terminationStates);
    updatedMap.set(processId, { confirming: false, pending: false, result });
    terminationStates = updatedMap;

    setTimeout(() => {
      terminationStates = new Map([...terminationStates].filter(([key]) => key !== processId));
    }, 3000);
  }

  function stateColorClass(state: string): string {
    switch (state) {
      case 'starting':
      case 'running':
        return 'text-green-500';
      case 'exited':
        return 'text-gray-400';
      case 'orphaned':
        return 'text-amber-500';
      default:
        return 'text-gray-400';
    }
  }

  function stateDotClass(state: string): string {
    switch (state) {
      case 'starting':
      case 'running':
        return 'bg-green-400';
      case 'exited':
        return 'bg-gray-400';
      case 'orphaned':
        return 'bg-amber-400';
      default:
        return 'bg-gray-400';
    }
  }

  let now = $state(Date.now());
  let timerInterval: ReturnType<typeof setInterval> | undefined;

  let hasLiveProcess = $derived(
    processTree.some((p) => p.state === 'starting' || p.state === 'running')
  );

  $effect(() => {
    if (hasLiveProcess) {
      timerInterval = setInterval(() => {
        now = Date.now();
      }, 1000);
    }

    return () => {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = undefined;
      }
    };
  });

  function elapsedFor(process: SessionProcessNode): string {
    // Reference `now` to make this reactive for live processes
    if (process.state === 'starting' || process.state === 'running') {
      void now;
    }
    return formatElapsedTime(process.startedAt, process.endedAt);
  }
</script>

{#if flatNodes.length === 0}
  <p class="py-2 text-xs text-muted-foreground">No active processes</p>
{:else}
  <ul role="tree" aria-label="Session processes" class="space-y-0.5">
    {#each flatNodes as node (node.process.processId)}
      {@const process = node.process}
      {@const ts = getTerminationState(process.processId)}
      {@const showTerminate = canTerminate(process) && sessionStatus === 'active'}
      <li
        role="treeitem"
        aria-selected="false"
        aria-label="{processKindLabel(process.kind)}: {process.label}"
        aria-level={node.depth + 1}
        class="flex items-center gap-2 py-0.5 text-xs"
        style:padding-left="{node.depth * 1.25}rem"
      >
        <span class="shrink-0 {stateColorClass(process.state)}" aria-hidden="true">
          {#if process.kind === 'tim'}
            <SquareTerminal class="size-3.5" />
          {:else}
            <Cpu class="size-3.5" />
          {/if}
        </span>

        <span
          class="h-1.5 w-1.5 shrink-0 rounded-full {stateDotClass(process.state)}"
          role="img"
          aria-label={processStateLabel(process.state)}
        ></span>

        <span class="min-w-0 truncate font-medium text-foreground">
          {process.label}
        </span>

        <span class="shrink-0 text-muted-foreground tabular-nums">
          {elapsedFor(process)}
        </span>

        {#if process.pid != null}
          <span class="shrink-0 text-muted-foreground/60" title="PID">
            {process.pid}
          </span>
        {/if}

        {#if process.state === 'exited' && process.exitCode != null}
          <span
            class="shrink-0 {process.exitCode === 0 ? 'text-muted-foreground' : 'text-red-400'}"
            title="Exit code"
          >
            exit {process.exitCode}
          </span>
        {/if}

        {#if process.state === 'exited' && process.signal}
          <span class="shrink-0 text-amber-400" title="Signal">
            {process.signal}
          </span>
        {/if}

        {#if showTerminate}
          {#if ts?.pending}
            <span class="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
              <Loader class="size-3 animate-spin" />
              <span>Terminating…</span>
            </span>
          {:else if ts?.confirming}
            <span class="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                class="rounded bg-red-600 px-1.5 py-0.5 text-xs font-medium text-white hover:bg-red-700"
                onclick={() => confirmTerminate(process.processId)}
              >
                Confirm
              </button>
              <button
                type="button"
                class="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                onclick={() => cancelTerminate(process.processId)}
              >
                Cancel
              </button>
            </span>
          {:else if ts?.result}
            {@const outcome = classifyTerminationStatus(ts.result.status)}
            <span
              class="ml-auto shrink-0 text-xs {outcome === 'success'
                ? 'text-green-400'
                : outcome === 'stale'
                  ? 'text-amber-400'
                  : 'text-red-400'}"
            >
              {terminationStatusMessage(ts.result.status)}
            </span>
          {:else}
            <button
              type="button"
              class="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-400 transition-colors hover:bg-red-950/40 hover:text-red-300"
              onclick={() => requestTerminate(process.processId)}
              title="Terminate executor"
              aria-label="Terminate {process.label}"
            >
              <OctagonX class="size-3" />
              Terminate
            </button>
          {/if}
        {/if}

        {#if !showTerminate && ts?.result}
          {@const outcome = classifyTerminationStatus(ts.result.status)}
          <span
            class="ml-auto shrink-0 text-xs {outcome === 'success'
              ? 'text-green-400'
              : outcome === 'stale'
                ? 'text-amber-400'
                : 'text-red-400'}"
          >
            {terminationStatusMessage(ts.result.status)}
          </span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
