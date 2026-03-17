<script lang="ts">
  let { priority }: { priority: string | null } = $props();

  const colorMap: Record<string, string> = {
    urgent: 'bg-red-100 text-red-800',
    high: 'bg-orange-100 text-orange-800',
    medium: 'bg-yellow-100 text-yellow-800',
    low: 'bg-blue-100 text-blue-800',
    maybe: 'bg-gray-100 text-gray-600',
  };

  let colorClass = $derived(priority ? (colorMap[priority] ?? 'bg-gray-100 text-gray-600') : '');
  let label = $derived(priority ? priority.charAt(0).toUpperCase() + priority.slice(1) : '');
</script>

{#if priority}
  <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium {colorClass}">
    {label}
  </span>
{/if}
