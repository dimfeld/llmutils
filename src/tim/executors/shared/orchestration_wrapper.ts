import {
  wrapWithOrchestration,
  wrapWithOrchestrationSimple,
  wrapWithOrchestrationTdd,
} from './orchestrator_prompt.ts';
import type { OrchestrationOptions } from './orchestration_options.ts';

export type OrchestrationExecutionMode = 'normal' | 'simple' | 'tdd';

/**
 * Applies the execution-mode-specific orchestration wrapper while keeping the
 * shared executor options in one place.
 *
 * Simple mode intentionally does not receive `reviewExecutor`, and only TDD
 * mode receives `simpleMode`. These omissions preserve the existing prompt
 * behavior for those wrappers.
 */
export function wrapForExecutionMode(
  mode: OrchestrationExecutionMode,
  contextContent: string,
  planId: string,
  options: OrchestrationOptions
): string {
  const { reviewExecutor, simpleMode, ...sharedOptions } = options;

  switch (mode) {
    case 'normal':
      return wrapWithOrchestration(contextContent, planId, {
        ...sharedOptions,
        reviewExecutor,
      });
    case 'simple':
      return wrapWithOrchestrationSimple(contextContent, planId, sharedOptions);
    case 'tdd':
      return wrapWithOrchestrationTdd(contextContent, planId, {
        ...sharedOptions,
        simpleMode,
        reviewExecutor,
      });
    default:
      throw new Error('Unsupported orchestration execution mode');
  }
}
