import type { MessageCategory } from '$lib/types/session.js';

export function categoryColorClass(category: MessageCategory): string {
  switch (category) {
    case 'lifecycle':
    case 'llmOutput':
      return 'text-green-400';
    case 'toolUse':
    case 'fileChange':
    case 'command':
      return 'text-cyan-400';
    case 'progress':
      return 'text-blue-400';
    case 'error':
      return 'text-red-400';
    case 'userInput':
      return 'text-orange-400';
    case 'log':
    default:
      return 'text-gray-300';
  }
}
