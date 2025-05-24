import { Node } from '../../state_machine/nodes.js';
import type { SharedStore } from '../../state_machine/store.js';
import type { StateResult, PrepResult } from '../../state_machine/types.js';
import type { WorkflowEvent, WorkflowContext, NodeExecutionResult } from './types.js';
import {
  ClaudeCodeExecutor,
  type ClaudeCodeExecutorOptions,
} from '../../rmplan/executors/claude_code.js';
import { trace } from '@opentelemetry/api';

export abstract class WorkflowNode<
  StateName extends string,
  TContext extends WorkflowContext,
  ARGS = any,
  AllStates extends string = StateName,
> extends Node<StateName, TContext, WorkflowEvent, undefined, ARGS, NodeExecutionResult> {
  protected abstract claudeCodeConfig: Partial<ClaudeCodeExecutorOptions>;
  protected model?: string;
  protected currentStore?: SharedStore<TContext, WorkflowEvent>;

  constructor(
    id: StateName,
    protected config: { maxRetries?: number; model?: string } = {}
  ) {
    super(id);
  }

  async prep(
    store: SharedStore<TContext, WorkflowEvent>
  ): Promise<PrepResult<WorkflowEvent, ARGS>> {
    this.currentStore = store;
    const events = store.pendingEvents.filter((e) => this.shouldProcessEvent(e));
    return {
      events,
      args: await this.prepareArgs(store.context),
    };
  }

  protected abstract shouldProcessEvent(event: WorkflowEvent): boolean;
  protected abstract prepareArgs(context: TContext): Promise<ARGS>;
  protected abstract getPrompt(args: ARGS, context: TContext): string;

  async exec(
    args: ARGS,
    events: WorkflowEvent[],
    scratchpad: undefined
  ): Promise<{ result: NodeExecutionResult; scratchpad: undefined }> {
    const span = trace.getActiveSpan();
    const maxRetries = this.config.maxRetries ?? 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        span?.addEvent('workflow_node_attempt', {
          node: this.id as string,
          attempt,
        });

        const result = await this.executeWithClaude(args);

        if (result.success) {
          return { result, scratchpad: undefined };
        }

        if (attempt < maxRetries) {
          span?.addEvent('workflow_node_retry', {
            node: this.id as string,
            attempt,
            error: result.error,
          });
          await this.delay(Math.pow(2, attempt) * 1000); // Exponential backoff
        }
      } catch (error) {
        span?.recordException(error as Error);

        if (attempt === maxRetries) {
          return {
            result: {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            },
            scratchpad: undefined,
          };
        }
      }
    }

    return {
      result: {
        success: false,
        error: 'Max retries exceeded',
      },
      scratchpad: undefined,
    };
  }

  protected async executeWithClaude(args: ARGS): Promise<NodeExecutionResult> {
    const context = this.getContext();
    if (!context) {
      return { success: false, error: 'No context available' };
    }

    const executor = new ClaudeCodeExecutor(
      this.claudeCodeConfig as ClaudeCodeExecutorOptions,
      {
        model: this.model || this.config.model || 'claude-3-5-sonnet-20241022',
        baseDir: context.workspaceDir || process.cwd(),
      },
      { defaultExecutor: 'claude-code' } // minimal rmplan config
    );

    try {
      const prompt = this.getPrompt(args, context);
      await executor.execute(prompt);

      // Since ClaudeCodeExecutor doesn't return a value, we assume success if no error was thrown
      return await this.processExecutorResult(undefined, args, context);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  protected abstract processExecutorResult(
    result: any,
    args: ARGS,
    context: TContext
  ): Promise<NodeExecutionResult>;

  async post(
    result: NodeExecutionResult,
    store: SharedStore<TContext, WorkflowEvent>
  ): Promise<StateResult<StateName, WorkflowEvent>> {
    const span = trace.getActiveSpan();

    // Update workflow state
    await store.context.store.updateWorkflow(store.context.workflowId, {
      metadata: {
        ...store.context.artifacts,
        lastNodeResult: result,
      },
    });

    // Save artifacts if any
    if (result.artifacts) {
      for (const [key, value] of Object.entries(result.artifacts)) {
        store.context.artifacts.set(key, value);
      }
    }

    if (result.success) {
      span?.addEvent('workflow_node_completed', {
        node: this.id as string,
      });

      const events: WorkflowEvent[] = [
        {
          id: `${store.context.workflowId}-${this.id}-complete`,
          type: 'workflow_step_complete',
          step: this.id as string,
          success: true,
          timestamp: Date.now(),
        },
      ];

      return {
        status: 'transition',
        actions: events,
        to: this.getNextState(result) as unknown as StateName,
      };
    } else {
      span?.addEvent('workflow_node_failed', {
        node: this.id as string,
        error: result.error,
      });

      const isRecoverable = this.isRecoverableError(result.error || '');

      const events: WorkflowEvent[] = [
        {
          id: `${store.context.workflowId}-${this.id}-error`,
          type: 'workflow_error',
          step: this.id as string,
          error: result.error || 'Unknown error',
          recoverable: isRecoverable,
          timestamp: Date.now(),
        },
      ];

      if (isRecoverable) {
        return {
          status: 'waiting',
          actions: events,
        };
      } else {
        return {
          status: 'transition',
          actions: events,
          to: this.getErrorState() as unknown as StateName,
        };
      }
    }
  }

  protected abstract getNextState(result: NodeExecutionResult): AllStates;
  protected abstract getErrorState(): AllStates;

  protected isRecoverableError(error: string): boolean {
    // Common recoverable errors
    const recoverablePatterns = [
      /rate limit/i,
      /timeout/i,
      /network error/i,
      /temporary/i,
      /try again/i,
    ];

    return recoverablePatterns.some((pattern) => pattern.test(error));
  }

  protected delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected getContext(): TContext | undefined {
    return this.currentStore?.context;
  }

  onError = async (
    error: Error,
    store: SharedStore<TContext, WorkflowEvent>
  ): Promise<StateResult<StateName, WorkflowEvent>> => {
    const span = trace.getActiveSpan();
    span?.recordException(error);

    const events: WorkflowEvent[] = [
      {
        id: `${store.context.workflowId}-${this.id}-error`,
        type: 'workflow_error',
        step: this.id as string,
        error: error.message,
        recoverable: false,
        timestamp: Date.now(),
      },
    ];

    return {
      status: 'transition',
      actions: events,
      to: this.getErrorState() as unknown as StateName,
    };
  };
}
