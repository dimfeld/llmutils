import { debugLog } from '../logging.ts';

type CleanupHandler = () => void | Promise<void>;

export class CleanupRegistry {
  private static instance: CleanupRegistry | undefined;
  private handlers: Map<number, CleanupHandler> = new Map();
  private idCounter = 0;

  private constructor() {}

  public static getInstance(): CleanupRegistry {
    if (!this.instance) {
      this.instance = new CleanupRegistry();
    }
    return this.instance;
  }

  /**
   * Register a cleanup handler that will be executed on process termination.
   * @param handler The cleanup function to register
   * @returns A function that can be called to unregister the handler
   */
  public register(handler: CleanupHandler): () => void {
    const id = this.idCounter++;
    this.handlers.set(id, handler);

    // Return unregister function
    return () => {
      this.handlers.delete(id);
    };
  }

  /**
   * Execute all registered cleanup handlers synchronously.
   * Errors during cleanup are caught and logged but do not prevent other handlers from running.
   * After execution, all handlers are cleared from the registry.
   */
  public executeAll(): void {
    for (const [id, handler] of this.handlers) {
      try {
        const result = handler();
        if (result instanceof Promise) {
          result.catch((error) => {
            debugLog(`Error during async cleanup handler execution (id: ${id}):`, error);
          });
        }
      } catch (error) {
        debugLog(`Error during cleanup handler execution (id: ${id}):`, error);
      }
    }

    this.handlers.clear();
  }

  /**
   * Execute all registered cleanup handlers and await async handlers.
   * Errors during cleanup are caught and logged but do not prevent other handlers from running.
   * After execution, all handlers are cleared from the registry.
   */
  public async executeAllAsync(): Promise<void> {
    for (const [id, handler] of this.handlers) {
      try {
        await handler();
      } catch (error) {
        debugLog(`Error during cleanup handler execution (id: ${id}):`, error);
      }
    }

    this.handlers.clear();
  }

  /**
   * Get the number of registered handlers (mainly for testing)
   */
  public get size(): number {
    return this.handlers.size;
  }
}
