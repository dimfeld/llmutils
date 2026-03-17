<script lang="ts">
  type WorkspaceStatus = 'primary' | 'locked' | 'available';

  let { status }: { status: WorkspaceStatus } = $props();

  const colorMap: Record<WorkspaceStatus, string> = {
    primary: 'bg-blue-100 text-blue-800',
    locked: 'bg-amber-100 text-amber-800',
    available: 'bg-gray-100 text-gray-700',
  };

  const labelMap: Record<WorkspaceStatus, string> = {
    primary: 'Primary',
    locked: 'Locked',
    available: 'Available',
  };

  let colorClass = $derived(colorMap[status] ?? 'bg-gray-100 text-gray-700');
  let label = $derived(labelMap[status] ?? status);
</script>

<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {colorClass}">
  {label}
</span>
