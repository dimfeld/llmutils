<script lang="ts">
  import type { SessionData } from '$lib/types/session.js';
  import {
    finishProjectChat,
    getProjectChatFinishInfo,
  } from '$lib/remote/project_chat_actions.remote.js';
  import { extractRemoteErrorMessage } from '$lib/utils/remote_error.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { untrack } from 'svelte';

  let { session }: { session: SessionData } = $props();
  const infoQuery = untrack(() => getProjectChatFinishInfo({ connectionId: session.connectionId }));
  let info = $derived(infoQuery.current);
  let open = $state(false);
  let summary = $state('');
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);
  let result = $state<Awaited<ReturnType<typeof finishProjectChat>> | null>(null);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!summary.trim() || submitting) return;
    submitting = true;
    errorMessage = null;
    try {
      result = await finishProjectChat({ connectionId: session.connectionId, summary });
      open = false;
    } catch (error) {
      errorMessage = extractRemoteErrorMessage(error);
    } finally {
      submitting = false;
    }
  }
</script>

{#if result?.status === 'pr'}
  <a
    href={result.url}
    target="_blank"
    rel="noopener noreferrer"
    class="text-xs text-blue-600 hover:underline dark:text-blue-400">View PR</a
  >
{:else if result?.status === 'integrated' || result?.status === 'already_integrated'}
  <span class="text-xs text-muted-foreground">Integrated into {result.branch}</span>
{:else if infoQuery.loading}
  <span class="text-xs text-muted-foreground">Checking chat branch…</span>
{:else if infoQuery.error}
  <span class="text-xs text-red-600 dark:text-red-400">Could not check chat branch</span>
{:else if info && !info.hasPushedChanges}
  <span class="text-xs text-muted-foreground">No changes were pushed</span>
{:else if info?.sessionEnded}
  <Button size="sm" variant="outline" onclick={() => (open = true)}>Finish work</Button>
{/if}

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Finish project chat</Dialog.Title>
      <Dialog.Description>
        {#if info?.workflow === 'pr-based'}
          Create a pull request from {info.branch} into {info.trunk}.
        {:else if info?.workflow === 'squash-rebase'}
          Squash the changes from {info?.branch} and push them to {info?.trunk}.
        {:else}
          Rebase the changes from {info?.branch} and push them to {info?.trunk}.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <form onsubmit={submit} class="space-y-4 py-2">
      <label class="block text-sm font-medium" for="project-chat-summary">Change summary</label>
      <input
        id="project-chat-summary"
        type="text"
        bind:value={summary}
        required
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        placeholder="Describe the changes"
      />
      {#if errorMessage}<p role="alert" class="text-sm text-red-600 dark:text-red-400">
          {errorMessage}
        </p>{/if}
      <div class="flex justify-end gap-2">
        <Button type="button" variant="outline" onclick={() => (open = false)} disabled={submitting}
          >Cancel</Button
        >
        <Button type="submit" disabled={submitting || !summary.trim()}
          >{submitting ? 'Finishing…' : 'Finish work'}</Button
        >
      </div>
    </form>
  </Dialog.Content>
</Dialog.Root>
