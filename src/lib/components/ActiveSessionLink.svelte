<script lang="ts">
  let {
    projectId,
    connectionId,
    class: className = '',
  }: {
    projectId: string;
    connectionId: string;
    class?: string;
  } = $props();
</script>

<a
  href="/projects/{projectId}/sessions/{encodeURIComponent(connectionId)}"
  class={['inline-flex items-center gap-1.5', className]}
  title="View the active session"
>
  <span class="inline-block size-1.5 animate-pulse rounded-full bg-current"></span>
  Session Active
</a>
