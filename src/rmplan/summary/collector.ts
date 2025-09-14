import { getGitRoot, getChangedFilesOnBranch } from '../../common/git.js';
import { debugLog } from '../../logging.js';
import type { ExecutionSummary, StepResult, SummaryExecutionMode } from './types.js';

const MAX_OUTPUT_LENGTH = 10_000_000; // 10MB like review formatter
const DEFAULT_TRUNCATE_LENGTH = 100_000; // Keep memory reasonable per step for terminal view

/**
 * Utility to safely truncate large text blocks for summaries.
 */
function truncate(text: string, maxLen = DEFAULT_TRUNCATE_LENGTH): string {
  if (typeof text !== 'string') return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n\n… truncated (showing first ${maxLen} of ${text.length} chars)`;
}

export interface SummaryCollectorInit {
  planId: string;
  planTitle: string;
  planFilePath: string;
  mode: SummaryExecutionMode;
}

export class SummaryCollector {
  private steps: StepResult[] = [];
  private changedFiles = new Set<string>();
  private errors: string[] = [];
  private startedAt: string = new Date().toISOString();
  private endedAt?: string;

  constructor(private init: SummaryCollectorInit) {}

  recordExecutionStart(): void {
    this.startedAt = new Date().toISOString();
  }

  recordExecutionEnd(): void {
    this.endedAt = new Date().toISOString();
  }

  addStepResult(input: Omit<StepResult, 'output'> & { output?: string | null; outputTruncateAt?: number }): void {
    try {
      let content: string | undefined;
      if (typeof input.output === 'string') {
        // Global safety cap first
        const capped = input.output.length > MAX_OUTPUT_LENGTH
          ? input.output.slice(0, MAX_OUTPUT_LENGTH)
          : input.output;
        // Then apply a display-oriented truncate
        content = truncate(capped, input.outputTruncateAt ?? DEFAULT_TRUNCATE_LENGTH);
      }

      const step: StepResult = {
        title: input.title,
        executor: input.executor,
        success: input.success,
        errorMessage: input.errorMessage,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationMs: input.durationMs,
        iteration: input.iteration,
        output: content != null ? { content } : undefined,
      };
      this.steps.push(step);
    } catch (e) {
      // Never throw from collector; just log and continue
      debugLog('SummaryCollector.addStepResult error: %o', e);
      this.errors.push(`Failed to add step result: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  addError(err: unknown): void {
    try {
      const msg = err instanceof Error ? err.message : String(err);
      this.errors.push(msg);
    } catch (e) {
      // ignore
    }
  }

  /**
   * Detects changed files against the base branch and merges into the collector's set.
   * Errors are captured but do not throw.
   */
  async trackFileChanges(baseDir?: string): Promise<void> {
    try {
      const gitRoot = await getGitRoot(baseDir);
      const files = await getChangedFilesOnBranch(gitRoot);
      for (const f of files) this.changedFiles.add(f);
    } catch (e) {
      debugLog('SummaryCollector.trackFileChanges error: %o', e);
      this.errors.push(
        `Failed to track file changes: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  getExecutionSummary(): ExecutionSummary {
    const endedAt = this.endedAt ?? new Date().toISOString();
    const started = new Date(this.startedAt).getTime();
    const ended = new Date(endedAt).getTime();
    const durationMs = isFinite(ended - started) ? Math.max(0, ended - started) : undefined;

    const failedSteps = this.steps.reduce((acc, s) => acc + (s.success ? 0 : 1), 0);

    return {
      planId: this.init.planId,
      planTitle: this.init.planTitle,
      planFilePath: this.init.planFilePath,
      mode: this.init.mode,
      startedAt: this.startedAt,
      endedAt,
      durationMs,
      steps: this.steps.slice(),
      changedFiles: Array.from(this.changedFiles),
      errors: this.errors.slice(),
      metadata: {
        totalSteps: this.steps.length,
        failedSteps,
        // batchIterations is set by batch mode integration where applicable
      },
      planInfo: {
        planId: this.init.planId,
        planTitle: this.init.planTitle,
        planFilePath: this.init.planFilePath,
      },
    };
  }
}

