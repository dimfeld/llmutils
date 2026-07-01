<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { toast } from 'svelte-sonner';
  import Upload from '@lucide/svelte/icons/upload';

  import { uploadArtifact } from './plan_artifact_upload.js';

  let {
    planUuid,
    projectId,
  }: {
    planUuid: string;
    projectId?: string | number;
  } = $props();

  let message: string = $state('');
  let reference = $state(true);
  let dragging = $state(false);
  let uploading = $state(false);
  let errorText: string | null = $state(null);
  let fileInput: HTMLInputElement | undefined = $state();

  async function uploadFile(
    file: File,
    uploadMessage: string,
    uploadReference: boolean
  ): Promise<boolean> {
    const result = await uploadArtifact({
      planUuid,
      projectId,
      file,
      message: uploadMessage,
      reference: uploadReference,
    });
    if (!result.ok) {
      errorText = result.error ?? 'Upload failed';
      return false;
    }
    toast.success(`Uploaded ${file.name}`);
    return true;
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (uploading) return;
    // Snapshot the message/reference state once for the whole batch so every file
    // in a multi-file selection is marked consistently.
    const messageSnapshot = message;
    const referenceSnapshot = reference;
    errorText = null;
    uploading = true;
    let uploadedAny = false;
    let batchSucceeded = true;
    try {
      for (const file of Array.from(files)) {
        const ok = await uploadFile(file, messageSnapshot, referenceSnapshot);
        if (!ok) {
          batchSucceeded = false;
          break;
        }
        uploadedAny = true;
      }
    } finally {
      uploading = false;
      if (fileInput) fileInput.value = '';
    }
    if (uploadedAny) {
      // Refresh the list for any successful uploads, even if a later file in the
      // batch failed. Only clear the form when the entire batch succeeded.
      if (batchSucceeded) {
        message = '';
        reference = true;
      }
      await invalidateAll();
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

  function onDragLeave(e: DragEvent) {
    // Ignore drag-leave events that fire when crossing into a child element of the dropzone.
    const current = e.currentTarget as Node | null;
    const related = e.relatedTarget as Node | null;
    if (current && related && current.contains(related)) {
      return;
    }
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
        Drop files here or click to choose (max 25 MB each)
      {/if}
    </div>
    <input
      bind:this={fileInput}
      type="file"
      multiple
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

  <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
    <input
      type="checkbox"
      bind:checked={reference}
      disabled={uploading}
      class="h-3.5 w-3.5"
      data-testid="artifact-reference-checkbox"
    />
    Reference artifact
  </label>

  {#if errorText}
    <p class="text-xs text-red-600 dark:text-red-400" role="alert">{errorText}</p>
  {/if}
</div>
