import type { MessageCategory } from '$lib/types/session.js';
import type { DisplayCategory } from './message_formatting.js';

export function categoryColorClass(category: MessageCategory | DisplayCategory): string {
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
    case 'structured':
    case 'log':
    default:
      return 'text-gray-300';
  }
}
