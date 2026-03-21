<script lang="ts">
  let { priority }: { priority: string | null } = $props();

  const colorMap: Record<string, string> = {
    urgent: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
    high: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
    medium: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
    low: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
    maybe: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
  };

  let colorClass = $derived(
    priority
      ? (colorMap[priority] ?? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300')
      : ''
  );
  let label = $derived(priority ? priority.charAt(0).toUpperCase() + priority.slice(1) : '');
</script>

{#if priority}
  <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {colorClass}">
    {label}
  </span>
{/if}
