import type { EnhancedCommand, CommandExecution } from './types.js';
import { EventEmitter } from 'events';
import { log } from '../../logging.js';

interface QueueEvents {
  'command:queued': (execution: CommandExecution) => void;
  'command:started': (execution: CommandExecution) => void;
  'command:completed': (execution: CommandExecution) => void;
  'command:failed': (execution: CommandExecution, error: Error) => void;
}

export class BranchCommandQueue extends EventEmitter {
  private activeCommands = new Map<string, CommandExecution>();
  private queuedCommands = new Map<string, CommandExecution[]>();

  constructor() {
    super();
  }

  async canExecute(command: EnhancedCommand, branch?: string): Promise<boolean> {
    const targetBranch = branch || command.branch || 'main';
    return !this.activeCommands.has(targetBranch);
  }

  async enqueue(command: EnhancedCommand, workflowId?: string): Promise<CommandExecution> {
    const branch = command.branch || 'main';

    const execution: CommandExecution = {
      command,
      branch,
      startedAt: new Date(),
      status: 'queued',
      workflowId,
    };

    // Check if branch is busy
    if (this.activeCommands.has(branch)) {
      // Add to queue
      const queue = this.queuedCommands.get(branch) || [];
      queue.push(execution);
      this.queuedCommands.set(branch, queue);

      log(`Command queued for branch ${branch}. Queue length: ${queue.length}`);
      this.emit('command:queued', execution);

      return execution;
    }

    // Branch is free, execute immediately
    execution.status = 'running';
    this.activeCommands.set(branch, execution);

    log(`Command starting on branch ${branch}`);
    this.emit('command:started', execution);

    return execution;
  }

  async complete(branch: string, success: boolean = true): Promise<void> {
    const execution = this.activeCommands.get(branch);
    if (!execution) {
      log(`No active command found for branch ${branch}`);
      return;
    }

    execution.status = success ? 'completed' : 'failed';
    this.activeCommands.delete(branch);

    if (success) {
      this.emit('command:completed', execution);
    } else {
      this.emit('command:failed', execution, new Error('Command failed'));
    }

    // Process queued commands for this branch
    await this.processQueue(branch);
  }

  async fail(branch: string, error: Error): Promise<void> {
    const execution = this.activeCommands.get(branch);
    if (!execution) {
      return;
    }

    execution.status = 'failed';
    this.activeCommands.delete(branch);

    log(`Command failed on branch ${branch}: ${error.message}`);
    this.emit('command:failed', execution, error);

    // Process queued commands for this branch
    await this.processQueue(branch);
  }

  private async processQueue(branch: string): Promise<void> {
    const queue = this.queuedCommands.get(branch);
    if (!queue || queue.length === 0) {
      return;
    }

    // Get next command from queue
    const nextExecution = queue.shift()!;
    if (queue.length === 0) {
      this.queuedCommands.delete(branch);
    }

    // Start the next command
    nextExecution.status = 'running';
    this.activeCommands.set(branch, nextExecution);

    log(`Starting queued command on branch ${branch}. Remaining in queue: ${queue.length}`);
    this.emit('command:started', nextExecution);
  }

  getActiveCommands(): CommandExecution[] {
    return Array.from(this.activeCommands.values());
  }

  getQueuedCommands(): CommandExecution[] {
    const allQueued: CommandExecution[] = [];
    for (const queue of this.queuedCommands.values()) {
      allQueued.push(...queue);
    }
    return allQueued;
  }

  getStatus(branch?: string): {
    active: CommandExecution[];
    queued: CommandExecution[];
  } {
    if (branch) {
      const active = this.activeCommands.get(branch);
      const queued = this.queuedCommands.get(branch) || [];
      return {
        active: active ? [active] : [],
        queued,
      };
    }

    return {
      active: this.getActiveCommands(),
      queued: this.getQueuedCommands(),
    };
  }

  async waitForBranch(branch: string, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();

    while (this.activeCommands.has(branch)) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Timeout waiting for branch ${branch} to become available`);
      }

      // Wait for completion event
      await new Promise<void>((resolve) => {
        const onComplete = (execution: CommandExecution) => {
          if (execution.branch === branch) {
            this.off('command:completed', onComplete);
            this.off('command:failed', onFailed);
            resolve();
          }
        };

        const onFailed = (execution: CommandExecution) => {
          if (execution.branch === branch) {
            this.off('command:completed', onComplete);
            this.off('command:failed', onFailed);
            resolve();
          }
        };

        this.once('command:completed', onComplete);
        this.once('command:failed', onFailed);

        // Check again in case it completed before we set up listeners
        if (!this.activeCommands.has(branch)) {
          this.off('command:completed', onComplete);
          this.off('command:failed', onFailed);
          resolve();
        }
      });
    }
  }

  // TypeScript helper for event emitter
  emit<K extends keyof QueueEvents>(event: K, ...args: Parameters<QueueEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]): this {
    return super.on(event, listener);
  }

  off<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]): this {
    return super.off(event, listener);
  }

  once<K extends keyof QueueEvents>(event: K, listener: QueueEvents[K]): this {
    return super.once(event, listener);
  }
}
