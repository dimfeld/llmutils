<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import Upload from '@lucide/svelte/icons/upload';

  import {
    buildUploadFormData,
    checkUploadSize,
    parseUploadError,
  } from './plan_artifact_upload.js';

  let {
    planUuid,
    projectId,
  }: {
    planUuid: string;
    projectId?: string | number;
  } = $props();

  let message: string = $state('');
  let dragging = $state(false);
  let uploading = $state(false);
  let errorText: string | null = $state(null);
  let fileInput: HTMLInputElement | undefined = $state();

  async function uploadFile(file: File) {
    if (uploading) return;
    errorText = null;

    const sizeCheck = checkUploadSize(file.size);
    if (!sizeCheck.ok) {
      errorText = sizeCheck.error ?? 'File too large';
      return;
    }

    const form = buildUploadFormData({ planUuid, projectId, file, message });

    uploading = true;
    try {
      const response = await fetch('/api/artifacts', {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        errorText = await parseUploadError(response);
        return;
      }

      message = '';
      toast.success(`Uploaded ${file.name}`);
      await invalidateAll();
    } catch (err) {
      errorText = `Upload failed: ${(err as Error).message}`;
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = '';
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      await uploadFile(file);
      if (errorText) break;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    void handleFiles(e.dataTransfer?.files ?? null);
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault();
    dragging = true;
  }

  function onDragLeave() {
    dragging = false;
  }

  function onFileChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    void handleFiles(input.files);
  }
</script>

<div class="space-y-2" data-testid="artifact-uploader">
  <div
    role="button"
    tabindex="0"
    aria-label="Upload artifact"
    class="flex flex-col items-center justify-center gap-2 rounded border-2 border-dashed px-4 py-6 text-center transition-colors {dragging
      ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30'
      : 'border-border bg-muted/30'} {uploading ? 'pointer-events-none opacity-60' : ''}"
    ondrop={onDrop}
    ondragover={onDragOver}
    ondragleave={onDragLeave}
    onclick={() => fileInput?.click()}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput?.click();
      }
    }}
  >
    <Upload class="size-5 text-muted-foreground" />
    <div class="text-xs text-muted-foreground">
      {#if uploading}
        Uploading…
      {:else}
        Drop a file here or click to choose (max 25 MB)
      {/if}
    </div>
    <input
      bind:this={fileInput}
      type="file"
      class="sr-only"
      onchange={onFileChange}
      disabled={uploading}
      data-testid="artifact-file-input"
    />
  </div>

  <input
    type="text"
    bind:value={message}
    placeholder="Optional message"
    disabled={uploading}
    class="w-full rounded border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:ring-1 focus:ring-ring focus:outline-none disabled:opacity-50"
    data-testid="artifact-message-input"
  />

  {#if errorText}
    <p class="text-xs text-red-600 dark:text-red-400" role="alert">{errorText}</p>
  {/if}
</div>
