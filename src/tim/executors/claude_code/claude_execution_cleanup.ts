type CleanupStep = () => void | Promise<void>;

export interface OrderedClaudeCleanup {
  readonly started: boolean;
  cleanup(): Promise<void>;
}

/**
 * Run execution cleanup in order, continue after failures, and report the
 * first failure. The returned promise is shared by every caller.
 */
export function createOrderedClaudeCleanup(steps: readonly CleanupStep[]): OrderedClaudeCleanup {
  let cleanupStarted = false;
  let cleanupPromise: Promise<void> | undefined;

  return {
    get started(): boolean {
      return cleanupStarted;
    },
    cleanup(): Promise<void> {
      if (cleanupPromise !== undefined) return cleanupPromise;
      cleanupStarted = true;
      cleanupPromise = (async (): Promise<void> => {
        let firstError: unknown;
        for (const step of steps) {
          try {
            await step();
          } catch (error) {
            firstError ??= error;
          }
        }
        if (firstError !== undefined) throw firstError;
      })();
      return cleanupPromise;
    },
  };
}
