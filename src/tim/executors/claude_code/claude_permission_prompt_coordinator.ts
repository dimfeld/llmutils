import type {
  ClaudePermissionPromptCoordinator,
  ClaudePermissionPromptRequest,
} from './claude_mcp_protocol.js';

/** Error returned when a permission prompt is removed from the coordinator. */
export class ClaudePermissionPromptCancelledError extends Error {
  public constructor(message = 'Claude permission prompt was cancelled') {
    super(message);
    this.name = 'ClaudePermissionPromptCancelledError';
  }
}

export function isClaudePermissionPromptCancelledError(
  error: unknown
): error is ClaudePermissionPromptCancelledError {
  return error instanceof ClaudePermissionPromptCancelledError;
}

interface QueueItem<T> {
  readonly request: ClaudePermissionPromptRequest<T>;
  readonly controller: AbortController;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
}

/**
 * Serializes interactive Claude permission work for one root session.
 *
 * The callback owns the complete interaction for one request. It receives the
 * same signal for every subprompt, so a Bash prefix selection or an entire
 * AskUserQuestion exchange keeps one queue slot and can be cancelled together.
 */
export class FifoClaudePermissionPromptCoordinator implements ClaudePermissionPromptCoordinator {
  private readonly queue: Array<QueueItem<unknown>> = [];
  private activeItem: QueueItem<unknown> | undefined;
  private activeCompletion: Promise<void> | undefined;
  private disposed = false;
  private disposalPromise: Promise<void> | undefined;

  public enqueue<T>(request: ClaudePermissionPromptRequest<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(
        new ClaudePermissionPromptCancelledError('Prompt coordinator disposed')
      );
    }

    return new Promise<T>((resolve, reject) => {
      const item: QueueItem<T> = {
        request,
        controller: new AbortController(),
        resolve,
        reject,
        settled: false,
      };
      this.queue.push(item as QueueItem<unknown>);
      this.startNext();
    });
  }

  public cancelRequester(requesterToken: string): void {
    if (this.disposed) return;

    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (item.request.requesterToken !== requesterToken) continue;
      this.queue.splice(index, 1);
      this.rejectItem(item);
    }

    if (this.activeItem?.request.requesterToken === requesterToken) {
      this.activeItem.controller.abort();
    }
  }

  public dispose(): Promise<void> {
    if (this.disposalPromise !== undefined) return this.disposalPromise;

    this.disposed = true;
    for (const item of this.queue.splice(0)) {
      this.rejectItem(item);
    }
    this.activeItem?.controller.abort();

    this.disposalPromise = this.activeCompletion ?? Promise.resolve();
    return this.disposalPromise;
  }

  private startNext(): void {
    if (this.disposed || this.activeItem !== undefined) return;

    const item = this.queue.shift();
    if (item === undefined) return;

    this.activeItem = item;
    this.activeCompletion = this.runItem(item);
    void this.activeCompletion;
  }

  private async runItem(item: QueueItem<unknown>): Promise<void> {
    try {
      const value = await item.request.run(item.controller.signal);
      if (item.controller.signal.aborted) {
        throw new ClaudePermissionPromptCancelledError();
      }
      this.resolveItem(item, value);
    } catch (error) {
      this.rejectItem(
        item,
        item.controller.signal.aborted ? new ClaudePermissionPromptCancelledError() : error
      );
    } finally {
      if (this.activeItem === item) {
        this.activeItem = undefined;
        this.activeCompletion = undefined;
      }
      this.startNext();
    }
  }

  private resolveItem(item: QueueItem<unknown>, value: unknown): void {
    if (item.settled) return;
    item.settled = true;
    item.resolve(value);
  }

  private rejectItem(
    item: QueueItem<unknown>,
    error: unknown = new ClaudePermissionPromptCancelledError()
  ): void {
    if (item.settled) return;
    item.settled = true;
    item.reject(error);
  }
}

export function createClaudePermissionPromptCoordinator(): FifoClaudePermissionPromptCoordinator {
  return new FifoClaudePermissionPromptCoordinator();
}
