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
    canEnd,
    classifyTerminationStatus,
    terminationStatusMessage,
    isLiveProcess,
    type ProcessTreeNode,
  } from './process_tree.js';

  interface Props {
    processTree: SessionProcessNode[];
    connectionId: string;
    sessionStatus: 'active' | 'offline' | 'notification';
    loading?: boolean;
  }

  let { processTree, connectionId, sessionStatus, loading = false }: Props = $props();
  const sessionManager = useSessionManager();

  let activeProcessTree = $derived(processTree.filter((process) => isLiveProcess(process.state)));
  let roots = $derived(buildProcessTree(activeProcessTree));
  let flatNodes = $derived(flattenTree(roots));

  type ControlOperation = 'terminate' | 'end';

  interface ControlState {
    operation: ControlOperation;
    confirming: boolean;
    pending: boolean;
    result: SessionExecutorTerminationResult | null;
  }

  let controlStates = $state(new Map<string, ControlState>());

  function getControlState(processId: string): ControlState | undefined {
    return controlStates.get(processId);
  }

  function requestControl(processId: string, operation: ControlOperation): void {
    const newMap = new Map(controlStates);
    newMap.set(processId, { operation, confirming: true, pending: false, result: null });
    controlStates = newMap;
  }

  function cancelControl(processId: string): void {
    const newMap = new Map(controlStates);
    newMap.delete(processId);
    controlStates = newMap;
  }

  async function confirmControl(processId: string): Promise<void> {
    const current = controlStates.get(processId);
    if (current?.pending) return;

    if (!current) return;

    const newMap = new Map(controlStates);
    newMap.set(processId, { ...current, confirming: false, pending: true, result: null });
    controlStates = newMap;

    const result =
      current.operation === 'end'
        ? await sessionManager.endExecutor(connectionId, processId)
        : await sessionManager.terminateExecutor(connectionId, processId);

    const outcome = classifyTerminationStatus(result.status);
    const message = terminationStatusMessage(result.status);

    if (outcome === 'success') {
      toast.success(message);
    } else if (outcome === 'stale') {
      toast.warning(message);
    } else {
      toast.error(message);
    }

    const updatedMap = new Map(controlStates);
    updatedMap.set(processId, { ...current, confirming: false, pending: false, result });
    controlStates = updatedMap;

    setTimeout(() => {
      controlStates = new Map([...controlStates].filter(([key]) => key !== processId));
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

  let hasLiveProcess = $derived(activeProcessTree.length > 0);

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

{#if loading && flatNodes.length === 0}
  <p class="py-2 text-xs text-muted-foreground" role="status">Loading processes…</p>
{:else if flatNodes.length === 0}
  <p class="py-2 text-xs text-muted-foreground">No active processes</p>
{:else}
  <ul role="tree" aria-label="Session processes" class="space-y-0.5">
    {#each flatNodes as node (node.process.processId)}
      {@const process = node.process}
      {@const cs = getControlState(process.processId)}
      {@const showTerminate = canTerminate(process) && sessionStatus === 'active'}
      {@const showEnd = canEnd(process) && sessionStatus === 'active'}
      {@const showControls = showTerminate || showEnd}
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

        {#if showControls || cs?.result}
          {#if cs?.pending}
            <span
              class="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <Loader class="size-3 animate-spin" />
              <span>{cs.operation === 'end' ? 'Ending…' : 'Terminating…'}</span>
            </span>
          {:else if cs?.confirming}
            <span class="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                class="rounded bg-red-600 px-1.5 py-0.5 text-xs font-medium text-white hover:bg-red-700"
                onclick={() => confirmControl(process.processId)}
              >
                Confirm
              </button>
              <button
                type="button"
                class="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                onclick={() => cancelControl(process.processId)}
              >
                Cancel
              </button>
            </span>
          {:else if cs?.result}
            {@const outcome = classifyTerminationStatus(cs.result.status)}
            <span
              role="status"
              aria-live="polite"
              class="ml-auto shrink-0 text-xs {outcome === 'success'
                ? 'text-green-400'
                : outcome === 'stale'
                  ? 'text-amber-400'
                  : 'text-red-400'}"
            >
              {terminationStatusMessage(cs.result.status)}
            </span>
          {:else}
            <span class="ml-auto flex shrink-0 items-center gap-1">
              {#if showEnd}
                <button
                  type="button"
                  class="rounded px-1.5 py-0.5 text-xs text-amber-400 transition-colors hover:bg-amber-950/40 hover:text-amber-300"
                  onclick={() => requestControl(process.processId, 'end')}
                  title="Gracefully end executor"
                  aria-label="End {process.label}"
                >
                  End
                </button>
              {/if}
              {#if showTerminate}
                <button
                  type="button"
                  class="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-400 transition-colors hover:bg-red-950/40 hover:text-red-300"
                  onclick={() => requestControl(process.processId, 'terminate')}
                  title="Terminate executor"
                  aria-label="Terminate {process.label}"
                >
                  <OctagonX class="size-3" />
                  Terminate
                </button>
              {/if}
            </span>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
{/if}
