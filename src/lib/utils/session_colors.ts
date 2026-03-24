import type { MessageCategory } from '$lib/types/session.js';
import type { DisplayCategory } from './message_formatting.js';

export function categoryColorClass(category: MessageCategory | DisplayCategory): string {
  switch (category) {
    case 'error':
      return 'text-red-400';
    case 'lifecycle':
      return 'text-gray-400';
    case 'llmOutput':
    case 'userInput':
      return 'text-gray-300';
    case 'toolUse':
    case 'command':
      return 'text-gray-300';
    case 'fileChange':
      return 'text-cyan-300';
    case 'progress':
      return 'text-gray-300';
    case 'structured':
    case 'log':
    default:
      return 'text-gray-300';
  }
}
