<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Download from '@lucide/svelte/icons/download';
  import File from '@lucide/svelte/icons/file';
  import FileAudio from '@lucide/svelte/icons/file-audio';
  import FileCode from '@lucide/svelte/icons/file-code';
  import FileImage from '@lucide/svelte/icons/file-image';
  import FileText from '@lucide/svelte/icons/file-text';
  import FileVideo from '@lucide/svelte/icons/file-video';

  import { Button } from '$lib/components/ui/button/index.js';
  import { renderMarkdown } from '$lib/utils/markdown_parser.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  let selectedIndex = $state(0);
  let selectedArtifact = $derived(data.artifacts[selectedIndex] ?? null);
  let renderedMarkdown = $derived(
    selectedArtifact?.viewKind === 'markdown' && selectedArtifact.content !== null
      ? renderMarkdown(selectedArtifact.content)
      : ''
  );
  let planHref = $derived(`/projects/${data.projectId}/plans/${data.plan.uuid}`);

  function iconFor(viewKind: string) {
    if (viewKind === 'image') return FileImage;
    if (viewKind === 'video') return FileVideo;
    if (viewKind === 'audio') return FileAudio;
    if (viewKind === 'markdown') return FileText;
    if (viewKind === 'html' || viewKind === 'source') return FileCode;
    return File;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function selectArtifact(index: number): void {
    if (index < 0 || index >= data.artifacts.length) return;
    selectedIndex = index;
  }

  function handleKeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    ) {
      return;
    }

    if (event.key === 'j') {
      event.preventDefault();
      selectArtifact(Math.min(selectedIndex + 1, data.artifacts.length - 1));
    } else if (event.key === 'k') {
      event.preventDefault();
      selectArtifact(Math.max(selectedIndex - 1, 0));
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex h-full min-h-0 flex-col">
  <header class="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
    <div class="min-w-0">
      <div class="mb-1 flex items-center gap-2">
        <Button href={planHref} variant="ghost" size="icon-xs" aria-label="Back to plan">
          <ArrowLeft class="size-3.5" />
        </Button>
        <p class="truncate text-xs text-muted-foreground">
          Plan #{data.plan.planId}
        </p>
      </div>
      <h2 class="truncate text-base font-semibold text-foreground">{data.plan.title}</h2>
    </div>
    {#if selectedArtifact}
      <Button
        href={selectedArtifact.url}
        variant="outline"
        size="xs"
        target="_blank"
        rel="noopener"
      >
        <Download class="size-3" />
        Open
      </Button>
    {/if}
  </header>

  {#if data.artifacts.length === 0}
    <div class="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
      This plan has no active artifacts.
    </div>
  {:else}
    <div class="grid min-h-0 flex-1 grid-cols-[18rem_minmax(0,1fr)]">
      <aside class="min-h-0 overflow-y-auto border-r border-border bg-muted/20">
        <div
          class="border-b border-border px-3 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          Files
        </div>
        <ul class="p-2">
          {#each data.artifacts as artifact, index (artifact.uuid)}
            {@const Icon = iconFor(artifact.viewKind)}
            <li>
              <button
                type="button"
                class={[
                  'flex w-full items-start gap-2 rounded px-2 py-2 text-left text-sm transition-colors',
                  index === selectedIndex
                    ? 'bg-primary/10 text-foreground ring-1 ring-primary/25'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                ]}
                onclick={() => selectArtifact(index)}
                aria-current={index === selectedIndex ? 'true' : undefined}
              >
                <Icon class="mt-0.5 size-4 shrink-0" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">{artifact.filename}</span>
                  <span class="mt-0.5 block text-xs text-muted-foreground">
                    {formatSize(artifact.size)}
                  </span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      </aside>

      <main class="min-h-0 overflow-y-auto bg-background">
        {#if selectedArtifact}
          <div class="border-b border-border px-5 py-3">
            <h3 class="text-sm font-semibold break-words text-foreground">
              {selectedArtifact.filename}
            </h3>
            <p class="mt-1 text-xs text-muted-foreground">
              {selectedArtifact.mimeType} · {formatSize(selectedArtifact.size)}
            </p>
          </div>

          <div class="p-5">
            {#if selectedArtifact.viewKind === 'markdown'}
              <div class="plan-rendered-content max-w-5xl text-sm">
                {@html renderedMarkdown}
              </div>
            {:else if selectedArtifact.viewKind === 'html'}
              <iframe
                class="h-[calc(100vh-11rem)] w-full rounded border border-border bg-white"
                title={selectedArtifact.filename}
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
                srcdoc={selectedArtifact.content ?? ''}
              ></iframe>
            {:else if selectedArtifact.viewKind === 'source'}
              <pre
                class="overflow-x-auto rounded border border-border bg-muted/30 p-4 text-sm leading-6 text-foreground"><code
                  >{selectedArtifact.content}</code
                ></pre>
            {:else if selectedArtifact.viewKind === 'image'}
              <img
                src={selectedArtifact.url}
                alt={selectedArtifact.filename}
                class="max-h-[calc(100vh-12rem)] max-w-full rounded border border-border object-contain"
              />
            {:else if selectedArtifact.viewKind === 'video'}
              <!-- svelte-ignore a11y_media_has_caption - arbitrary trusted artifacts rarely include caption tracks -->
              <video
                src={selectedArtifact.url}
                controls
                class="max-h-[calc(100vh-12rem)] max-w-full rounded border border-border"
              ></video>
            {:else if selectedArtifact.viewKind === 'audio'}
              <audio src={selectedArtifact.url} controls class="w-full max-w-3xl"></audio>
            {:else if selectedArtifact.viewKind === 'pdf'}
              <iframe
                class="h-[calc(100vh-11rem)] w-full rounded border border-border"
                title={selectedArtifact.filename}
                src={selectedArtifact.url}
              ></iframe>
            {:else if selectedArtifact.viewKind === 'missing'}
              <div
                class="rounded border border-border bg-muted/30 p-4 text-sm text-muted-foreground"
              >
                This artifact file is not available on this node yet.
              </div>
            {:else if selectedArtifact.viewKind === 'too_large'}
              <div
                class="rounded border border-border bg-muted/30 p-4 text-sm text-muted-foreground"
              >
                This text artifact is too large to preview inline.
              </div>
            {:else}
              <div
                class="rounded border border-border bg-muted/30 p-4 text-sm text-muted-foreground"
              >
                This artifact type cannot be previewed inline.
              </div>
            {/if}
          </div>
        {/if}
      </main>
    </div>
  {/if}
</div>
