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
  import { createArtifactImageUrlResolver } from '$lib/utils/artifact_markdown_images.js';
  import { renderMarkdown } from '$lib/utils/markdown_parser.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type ArtifactViewFile = PageData['artifacts'][number];

  function isReport(filename: string): boolean {
    return filename.slice(filename.lastIndexOf('/') + 1).toLowerCase() === 'report.md';
  }

  let reportIndex = $derived(data.artifacts.findIndex((artifact) => isReport(artifact.filename)));
  let reportArtifact = $derived(reportIndex >= 0 ? data.artifacts[reportIndex] : null);
  // Pin report.md to the right pane only when there's something else to show on the left.
  let showSplit = $derived(reportArtifact !== null && data.artifacts.length > 1);

  // Default the selection to the first non-report artifact when a report is pinned,
  // so the split view doesn't show report.md in both panes on load.
  let selectedIndex = $state(
    (() => {
      const ri = data.artifacts.findIndex((artifact) => isReport(artifact.filename));
      if (ri === -1) return 0;
      const firstOther = data.artifacts.findIndex((_, index) => index !== ri);
      return firstOther === -1 ? ri : firstOther;
    })()
  );
  let selectedArtifact = $derived(data.artifacts[selectedIndex] ?? null);
  let selectedIsReport = $derived(selectedArtifact !== null && isReport(selectedArtifact.filename));
  let resolveArtifactImageUrl = $derived(createArtifactImageUrlResolver(data.artifacts));

  function renderedFor(artifact: ArtifactViewFile | null): string {
    return artifact?.viewKind === 'markdown' && artifact.content !== null
      ? renderMarkdown(artifact.content, { resolveImageUrl: resolveArtifactImageUrl })
      : '';
  }

  let renderedMarkdown = $derived(renderedFor(selectedArtifact));
  let reportRenderedMarkdown = $derived(renderedFor(reportArtifact));
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
        <a href={planHref} class="truncate text-xs text-muted-foreground hover:text-foreground">
          Plan #{data.plan.planId}
        </a>
      </div>
      <h2 class="truncate text-base font-semibold text-foreground">{data.plan.title}</h2>
    </div>
    {#if data.artifacts.length > 0}
      <Button
        href={`/api/plans/${data.plan.uuid}/artifacts/archive`}
        variant="outline"
        size="xs"
        aria-label="Download all artifacts"
        title="Download all artifacts"
      >
        <Download class="size-3" />
        Download ZIP
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

      {#if showSplit}
        <div class="grid min-h-0 grid-cols-2 divide-x divide-border">
          <main class="min-h-0 overflow-y-auto bg-background">
            {#if selectedIsReport}
              <div
                class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground"
              >
                report.md is pinned in the panel on the right.
              </div>
            {:else if selectedArtifact}
              {@render artifactPane(selectedArtifact, renderedMarkdown)}
            {/if}
          </main>

          <section class="min-h-0 overflow-y-auto bg-muted/10">
            {#if reportArtifact}
              {@render artifactPane(reportArtifact, reportRenderedMarkdown, 'Report')}
            {/if}
          </section>
        </div>
      {:else}
        <main class="min-h-0 overflow-y-auto bg-background">
          {#if selectedArtifact}
            {@render artifactPane(selectedArtifact, renderedMarkdown)}
          {/if}
        </main>
      {/if}
    </div>
  {/if}
</div>

{#snippet artifactPane(artifact: ArtifactViewFile, renderedHtml: string, label?: string)}
  <div class="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
    <div class="min-w-0">
      {#if label}
        <p class="mb-0.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </p>
      {/if}
      <h3 class="text-sm font-semibold break-words text-foreground">
        {artifact.filename}
      </h3>
      <p class="mt-1 text-xs text-muted-foreground">
        {artifact.mimeType} · {formatSize(artifact.size)}
      </p>
    </div>
    {#if artifact.viewKind !== 'missing'}
      <Button
        href={artifact.downloadUrl}
        variant="outline"
        size="xs"
        target="_blank"
        rel="noopener"
        aria-label="Open {artifact.filename}"
        title="Open {artifact.filename}"
      >
        <Download class="size-3" />
        Open
      </Button>
    {/if}
  </div>

  <div class="p-5">
    {#if artifact.viewKind === 'markdown'}
      <div class="plan-rendered-content max-w-5xl text-sm">
        {@html renderedHtml}
      </div>
    {:else if artifact.viewKind === 'html'}
      <iframe
        class="h-[calc(100vh-11rem)] w-full rounded border border-border bg-white"
        title={artifact.filename}
        sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
        srcdoc={artifact.content ?? ''}
      ></iframe>
    {:else if artifact.viewKind === 'source'}
      <pre
        class="overflow-x-auto rounded border border-border bg-muted/30 p-4 text-sm leading-6 text-foreground"><code
          >{artifact.content}</code
        ></pre>
    {:else if artifact.viewKind === 'image'}
      <img
        src={artifact.url}
        alt={artifact.filename}
        class="max-h-[calc(100vh-12rem)] max-w-full rounded border border-border object-contain"
      />
    {:else if artifact.viewKind === 'video'}
      <!-- svelte-ignore a11y_media_has_caption - arbitrary trusted artifacts rarely include caption tracks -->
      <video
        src={artifact.url}
        controls
        class="max-h-[calc(100vh-12rem)] max-w-full rounded border border-border"
      ></video>
    {:else if artifact.viewKind === 'audio'}
      <audio src={artifact.url} controls class="w-full max-w-3xl"></audio>
    {:else if artifact.viewKind === 'pdf'}
      <iframe
        class="h-[calc(100vh-11rem)] w-full rounded border border-border"
        title={artifact.filename}
        src={artifact.url}
      ></iframe>
    {:else if artifact.viewKind === 'missing'}
      <div class="rounded border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        This artifact file is not available on this node yet.
      </div>
    {:else if artifact.viewKind === 'too_large'}
      <div class="rounded border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        This text artifact is too large to preview inline.
      </div>
    {:else}
      <div class="rounded border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        This artifact type cannot be previewed inline.
      </div>
    {/if}
  </div>
{/snippet}
