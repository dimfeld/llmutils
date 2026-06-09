<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteSet } from 'svelte/reactivity';
  import { toast } from 'svelte-sonner';
  import FileIcon from '@lucide/svelte/icons/file';
  import FileImage from '@lucide/svelte/icons/file-image';
  import FileText from '@lucide/svelte/icons/file-text';
  import FileVideo from '@lucide/svelte/icons/file-video';
  import FileAudio from '@lucide/svelte/icons/file-audio';
  import FileArchive from '@lucide/svelte/icons/file-archive';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Undo2 from '@lucide/svelte/icons/undo-2';

  import type { PlanArtifactWithTransferState } from '$tim/artifacts/service.js';
  import { softDeleteArtifact, restoreArtifact } from '$lib/remote/artifact_actions.remote.js';
  import { formatRelativeTime } from '$lib/utils/time.js';
  import * as Collapsible from '$lib/components/ui/collapsible/index.js';
  import { buildShowDeletedUrl } from './plan_artifact_upload.js';

  let {
    artifacts,
  }: {
    artifacts: PlanArtifactWithTransferState[];
  } = $props();

  let open = $state(true);
  let pendingUuids = new SvelteSet<string>();

  let showDeleted = $derived(page.url.searchParams.get('includeDeletedArtifacts') === '1');

  let visibleArtifacts = $derived(
    showDeleted ? artifacts : artifacts.filter((a) => a.deletedAt === null)
  );

  let activeCount = $derived(artifacts.filter((a) => a.deletedAt === null).length);

  function canPreviewInline(mime: string): boolean {
    return (
      mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp'
    );
  }

  function isProofArtifact(message: string | null): boolean {
    return message?.startsWith('tim-proof:') === true;
  }

  function iconFor(mime: string) {
    if (mime.startsWith('image/')) return FileImage;
    if (mime.startsWith('video/')) return FileVideo;
    if (mime.startsWith('audio/')) return FileAudio;
    if (mime.startsWith('text/') || mime === 'application/json') return FileText;
    if (mime === 'application/zip' || mime === 'application/x-tar' || mime === 'application/gzip')
      return FileArchive;
    return FileIcon;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  async function toggleShowDeleted() {
    const target = buildShowDeletedUrl(page.url, !showDeleted);
    await goto(target, { keepFocus: true, noScroll: true });
  }

  async function handleSoftDelete(uuid: string) {
    if (pendingUuids.has(uuid)) return;
    pendingUuids.add(uuid);
    try {
      await softDeleteArtifact({ uuid });
      await invalidateAll();
    } catch (err) {
      toast.error(`Failed to delete artifact: ${(err as Error).message}`);
    } finally {
      pendingUuids.delete(uuid);
    }
  }

  async function handleRestore(uuid: string) {
    if (pendingUuids.has(uuid)) return;
    pendingUuids.add(uuid);
    try {
      await restoreArtifact({ uuid });
      await invalidateAll();
    } catch (err) {
      toast.error(`Failed to restore artifact: ${(err as Error).message}`);
    } finally {
      pendingUuids.delete(uuid);
    }
  }
</script>

<div>
  <Collapsible.Root bind:open>
    <Collapsible.Trigger
      class="flex w-full cursor-pointer items-center justify-between rounded px-0 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
      aria-label="Toggle artifacts"
    >
      <h3 class="text-xs font-semibold tracking-wide uppercase">
        Artifacts ({activeCount})
      </h3>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="transition-transform {open ? 'rotate-180' : ''}"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </Collapsible.Trigger>
    <Collapsible.Content>
      <div class="mt-2 mb-2 flex items-center justify-end">
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={showDeleted}
            onchange={toggleShowDeleted}
            class="h-3.5 w-3.5"
          />
          Show deleted
        </label>
      </div>

      {#if visibleArtifacts.length === 0}
        <p class="text-xs text-muted-foreground italic">No artifacts yet.</p>
      {:else}
        <ul class="space-y-2" data-testid="artifact-list">
          {#each visibleArtifacts as artifact (artifact.uuid)}
            {@const Icon = iconFor(artifact.mimeType)}
            {@const downloadUrl = `/api/artifacts/${artifact.uuid}`}
            {@const openUrl = isProofArtifact(artifact.message)
              ? `${downloadUrl}?view=1`
              : downloadUrl}
            {@const isDeleted = artifact.deletedAt !== null}
            {@const fileMissing = artifact.transferState === 'file-missing'}
            {@const downloadable = !isDeleted && !fileMissing}
            {@const isPending = pendingUuids.has(artifact.uuid)}
            <li
              class="group rounded border border-border bg-card px-3 py-2 text-sm {isDeleted
                ? 'opacity-60'
                : ''}"
              data-testid="artifact-row"
              data-artifact-uuid={artifact.uuid}
            >
              <div class="flex items-start gap-3">
                {#if canPreviewInline(artifact.mimeType) && downloadable}
                  <a
                    href={openUrl}
                    target="_blank"
                    rel="noopener"
                    class="block shrink-0"
                    aria-label="Open {artifact.filename}"
                  >
                    <img
                      src={downloadUrl}
                      alt={artifact.filename}
                      class="max-h-24 max-w-32 rounded border border-border object-contain"
                      loading="lazy"
                    />
                  </a>
                {:else}
                  <Icon class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                {/if}

                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    {#if downloadable}
                      <a
                        href={openUrl}
                        target="_blank"
                        rel="noopener"
                        class="font-medium text-foreground hover:underline"
                      >
                        {artifact.filename}
                      </a>
                    {:else}
                      <span class="font-medium text-foreground">
                        {artifact.filename}
                      </span>
                    {/if}
                    <span class="text-xs text-muted-foreground">
                      {formatSize(artifact.size)}
                    </span>
                    <span class="text-xs text-muted-foreground">·</span>
                    <span class="text-xs text-muted-foreground" title={artifact.createdAt}>
                      {formatRelativeTime(artifact.createdAt)}
                    </span>

                    {#if fileMissing}
                      <span
                        class="rounded bg-yellow-100 px-1.5 py-0.5 text-[10px] font-medium text-yellow-700 dark:bg-yellow-950/50 dark:text-yellow-400"
                        title="The file has not been downloaded to this node yet"
                      >
                        Sync in progress
                      </span>
                    {:else if artifact.transferState === 'pending' || artifact.transferState === 'in_progress'}
                      <span
                        class="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-400"
                      >
                        {artifact.transferState === 'pending' ? 'Pending' : 'Transferring'}
                      </span>
                    {:else if artifact.transferState === 'failed'}
                      <span
                        class="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950/50 dark:text-red-400"
                      >
                        Transfer failed
                      </span>
                    {/if}

                    {#if isDeleted}
                      <span
                        class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                      >
                        Deleted
                      </span>
                    {/if}

                    <div class="ml-auto flex shrink-0 items-center gap-1">
                      {#if isDeleted}
                        <button
                          type="button"
                          onclick={() => handleRestore(artifact.uuid)}
                          disabled={isPending}
                          class="rounded p-1 text-muted-foreground hover:bg-blue-100 hover:text-blue-700 disabled:opacity-50 dark:hover:bg-blue-950/50 dark:hover:text-blue-400"
                          aria-label="Restore artifact"
                          title="Restore"
                        >
                          <Undo2 class="size-3.5" />
                        </button>
                      {:else}
                        <button
                          type="button"
                          onclick={() => handleSoftDelete(artifact.uuid)}
                          disabled={isPending}
                          class="rounded p-1 text-muted-foreground hover:bg-red-100 hover:text-red-700 disabled:opacity-50 dark:hover:bg-red-950/50 dark:hover:text-red-400"
                          aria-label="Delete artifact"
                          title="Delete"
                        >
                          <Trash2 class="size-3.5" />
                        </button>
                      {/if}
                    </div>
                  </div>

                  {#if artifact.message}
                    <p class="mt-1 text-xs text-foreground">{artifact.message}</p>
                  {/if}
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </Collapsible.Content>
  </Collapsible.Root>
</div>
