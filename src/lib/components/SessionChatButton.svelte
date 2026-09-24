<script lang="ts">
  import type { ChatExecutorOption } from '$tim/configSchema.js';
  import { startChat } from '$lib/remote/plan_actions.remote.js';
  import { startPrChat } from '$lib/remote/review_thread_actions.remote.js';
  import { useSessionManager } from '$lib/stores/session_state.svelte.js';
  import { useSessionWindows } from '$lib/stores/session_windows.svelte.js';
  import { extractRemoteErrorMessage } from '$lib/utils/remote_error.js';
  import {
    DEFAULT_CHAT_EXECUTOR_OPTIONS,
    chatExecutorLabel,
    chatOptionKey,
  } from '$lib/utils/chat_executor_options.js';
  import { Button, type ButtonVariant } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';

  export type ChatTarget = { planUuid: string } | { projectId: string; prNumber: number };

  let {
    target,
    returnTo = undefined,
    chatExecutorOptions = DEFAULT_CHAT_EXECUTOR_OPTIONS,
    variant = 'ghost',
    buttonClass = '',
  }: {
    target: ChatTarget;
    returnTo?: string;
    chatExecutorOptions?: ChatExecutorOption[];
    variant?: ButtonVariant;
    buttonClass?: string;
  } = $props();

  let subject = $derived('planUuid' in target ? 'plan' : 'PR');
  const sessions = useSessionManager();
  const windows = useSessionWindows();
  let chatDialogOpen = $state(false);
  let startingChat = $state<string | false>(false);
  let pending = $state<{ planUuid: string } | { prUrl: string } | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!pending) return;
    const candidates =
      'planUuid' in pending
        ? sessions.sessionsByPlanUuid.get(pending.planUuid)
        : sessions.sessionsByPrUrl.get(pending.prUrl);
    const session = candidates?.find((session) => session.status === 'active');
    if (session) {
      windows?.open(session.connectionId);
      pending = null;
    }
  });

  async function start(option: ChatExecutorOption): Promise<void> {
    const optionKey = chatOptionKey(option);
    startingChat = optionKey;
    error = null;
    try {
      const launchTarget = target;
      const result =
        'planUuid' in launchTarget
          ? await startChat({
              planUuid: launchTarget.planUuid,
              executor: option.executor,
              model: option.model,
              returnTo,
            })
          : await startPrChat({
              projectId: Number(launchTarget.projectId),
              prNumber: launchTarget.prNumber,
              executor: option.executor,
              model: option.model,
              returnTo,
            });
      if (result.status === 'already_running') {
        if (result.connectionId) windows?.open(result.connectionId);
        else error = 'A session is starting. Try again when it is ready.';
      } else {
        pending =
          'planUuid' in launchTarget
            ? { planUuid: launchTarget.planUuid }
            : 'prUrl' in result
              ? { prUrl: result.prUrl }
              : null;
        chatDialogOpen = false;
      }
    } catch (err) {
      error = extractRemoteErrorMessage(err);
    } finally {
      startingChat = false;
      chatDialogOpen = false;
    }
  }
</script>

{#if windows}
  <div class="flex flex-wrap items-center gap-2">
    <Button
      {variant}
      size="sm"
      class={buttonClass}
      onclick={() => {
        error = null;
        chatDialogOpen = true;
      }}
      disabled={!!startingChat}
      aria-label={`Chat with ${subject}`}>Chat</Button
    >
    {#if pending}
      <span role="status" class="text-sm text-muted-foreground">Waiting for session…</span>
    {/if}
    {#if error}<span role="alert" class="text-sm text-red-600 dark:text-red-400">{error}</span>{/if}
  </div>

  <Dialog.Root
    open={chatDialogOpen}
    onOpenChange={(open) => {
      if (!open && startingChat) return;
      chatDialogOpen = open;
    }}
  >
    <Dialog.Content class="sm:max-w-md">
      <Dialog.Header>
        <Dialog.Title>Start Chat Session</Dialog.Title>
        <Dialog.Description>Choose an executor and model</Dialog.Description>
      </Dialog.Header>
      <div class="grid gap-3 py-4">
        {#each chatExecutorOptions as option (chatOptionKey(option))}
          {@const optionKey = chatOptionKey(option)}
          <Button onclick={() => start(option)} class="justify-between" disabled={!!startingChat}>
            {#if startingChat === optionKey}
              <span
                class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
              ></span>
              Starting…
            {:else}
              <span>{chatExecutorLabel(option.executor)}</span>
              <span class="text-xs opacity-80">{option.model ?? 'Default model'}</span>
            {/if}
          </Button>
        {/each}
      </div>
    </Dialog.Content>
  </Dialog.Root>
{/if}
