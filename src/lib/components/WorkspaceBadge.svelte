<script lang="ts">
  type WorkspaceStatus = 'primary' | 'auto' | 'locked' | 'available';

  let { status }: { status: WorkspaceStatus } = $props();

  const colorMap: Record<WorkspaceStatus, string> = {
    primary: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    auto: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
    locked: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
    available: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  };

  const labelMap: Record<WorkspaceStatus, string> = {
    primary: 'Primary',
    auto: 'Auto',
    locked: 'Locked',
    available: 'Available',
  };

  let colorClass = $derived(
    colorMap[status] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
  );
  let label = $derived(labelMap[status] ?? status);
</script>

<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {colorClass}">
  {label}
</span>
