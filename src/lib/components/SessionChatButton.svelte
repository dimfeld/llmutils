<script lang="ts">
  import type { ChatExecutorOption } from '$tim/configSchema.js';
  import { startChat } from '$lib/remote/plan_actions.remote.js';
  import { startPrChat } from '$lib/remote/review_thread_actions.remote.js';
  import { startProjectChat } from '$lib/remote/project_chat_actions.remote.js';
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

  export type ChatTarget =
    | { planUuid: string }
    | { projectId: string; prNumber: number }
    | { projectId: string; projectChat: true };

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

  let subject = $derived(
    'planUuid' in target ? 'plan' : 'projectChat' in target ? 'project' : 'PR'
  );
  const sessions = useSessionManager();
  const windows = useSessionWindows();
  let chatDialogOpen = $state(false);
  let startingChat = $state<string | false>(false);
  let pending = $state<{ planUuid: string } | { prUrl: string } | { projectChatId: string } | null>(
    null
  );
  let error = $state<string | null>(null);

  $effect(() => {
    const pendingTarget = pending;
    if (!pendingTarget) return;
    const session =
      'projectChatId' in pendingTarget
        ? [...sessions.sessions.values()].find(
            (candidate) => candidate.sessionInfo.projectChatId === pendingTarget.projectChatId
          )
        : ('planUuid' in pendingTarget
            ? sessions.sessionsByPlanUuid.get(pendingTarget.planUuid)
            : sessions.sessionsByPrUrl.get(pendingTarget.prUrl)
          )?.find((candidate) => candidate.status === 'active');
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
        'projectChat' in launchTarget
          ? await startProjectChat({
              projectId: Number(launchTarget.projectId),
              executor: option.executor,
              model: option.model,
            })
          : 'planUuid' in launchTarget
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
          'projectChat' in launchTarget && 'chatId' in result
            ? { projectChatId: result.chatId }
            : 'planUuid' in launchTarget
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

  function handleChoiceKeydown(event: KeyboardEvent): void {
    if (
      !chatDialogOpen ||
      startingChat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.repeat
    ) {
      return;
    }
    if (!/^[1-9]$/.test(event.key)) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('input, textarea, select, [contenteditable="true"]')
    ) {
      return;
    }

    const option = chatExecutorOptions[Number(event.key) - 1];
    if (!option) return;
    event.preventDefault();
    void start(option);
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
      aria-label={`Chat with ${subject}`}
      >{subject === 'project' ? 'New project chat' : 'Chat'}</Button
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
    <Dialog.Content class="sm:max-w-md" onkeydown={handleChoiceKeydown}>
      <Dialog.Header>
        <Dialog.Title>Start Chat Session</Dialog.Title>
        <Dialog.Description>Choose a model. Press its number to start quickly.</Dialog.Description>
      </Dialog.Header>
      <div class="grid gap-3 py-4">
        {#each chatExecutorOptions as option, index (chatOptionKey(option))}
          {@const optionKey = chatOptionKey(option)}
          <Button
            onclick={() => start(option)}
            class="h-auto justify-between gap-3 py-3 text-left"
            disabled={!!startingChat}
          >
            <span class="flex min-w-0 flex-col gap-0.5">
              <span class="truncate text-sm font-semibold">{option.model ?? 'Default model'}</span>
              <span class="text-xs font-normal opacity-75"
                >{chatExecutorLabel(option.executor)}</span
              >
            </span>
            {#if startingChat === optionKey}
              <span class="text-xs font-normal">Starting…</span>
            {:else if index < 9}
              <kbd
                class="rounded border border-current/30 px-1.5 py-0.5 text-xs font-normal opacity-75"
                >{index + 1}</kbd
              >
            {/if}
          </Button>
        {/each}
      </div>
    </Dialog.Content>
  </Dialog.Root>
{/if}
