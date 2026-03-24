import type { MessageCategory } from '$lib/types/session.js';

export function categoryColorClass(category: MessageCategory): string {
  switch (category) {
    case 'error':
      return 'text-red-400';
    case 'structured':
    case 'log':
    default:
      return 'text-gray-300';
  }
}
