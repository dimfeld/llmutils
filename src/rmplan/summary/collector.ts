import {
  getGitRoot,
  getChangedFilesOnBranch,
  getCurrentCommitHash,
  getChangedFilesBetween,
} from '../../common/git.js';
import { debugLog } from '../../logging.js';
import type {
  ExecutionSummary,
  StepResult,
  SummaryExecutionMode,
  NormalizedExecutorOutput,
} from './types.js';

const MAX_OUTPUT_LENGTH = 10_000_000; // 10MB like review formatter
const DEFAULT_TRUNCATE_LENGTH = 100_000; // Keep memory reasonable per step for terminal view

/**
 * Utility to safely truncate large text blocks for summaries.
 */
function truncate(text: string, maxLen = DEFAULT_TRUNCATE_LENGTH): string {
  if (typeof text !== 'string') return '';
  if (text.length <= maxLen) return text;
  return (
    text.slice(0, maxLen) + `\n\n… truncated (showing first ${maxLen} of ${text.length} chars)`
  );
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
  private batchIterations?: number;
  private baselineRevision?: string | null;

  constructor(private init: SummaryCollectorInit) {}

  recordExecutionStart(): void {
    this.startedAt = new Date().toISOString();
    // Capture baseline revision for accurate change tracking
    // Best-effort: failures are ignored and tracked when computing changes
    getGitRoot()
      .then((root) => getCurrentCommitHash(root))
      .then((rev) => {
        this.baselineRevision = rev;
      })
      .catch(() => {
        this.baselineRevision = undefined;
      });
  }

  recordExecutionEnd(): void {
    this.endedAt = new Date().toISOString();
  }

  addStepResult(
    input: Omit<StepResult, 'output'> & {
      output?: string | NormalizedExecutorOutput | null;
      outputTruncateAt?: number;
    }
  ): void {
    try {
      let normalized: NormalizedExecutorOutput | undefined;
      if (typeof input.output === 'string') {
        const capped =
          input.output.length > MAX_OUTPUT_LENGTH
            ? input.output.slice(0, MAX_OUTPUT_LENGTH)
            : input.output;
        normalized = {
          content: truncate(capped, input.outputTruncateAt ?? DEFAULT_TRUNCATE_LENGTH),
        };
      } else if (input.output && typeof input.output === 'object') {
        const rawContent =
          typeof (input.output as any).content === 'string'
            ? (input.output as any).content
            : String((input.output as any).content ?? '');
        const capped =
          rawContent.length > MAX_OUTPUT_LENGTH
            ? rawContent.slice(0, MAX_OUTPUT_LENGTH)
            : rawContent;
        normalized = {
          content: truncate(capped, input.outputTruncateAt ?? DEFAULT_TRUNCATE_LENGTH),
          metadata: (input.output as any).metadata,
        };
      }

      const step: StepResult = {
        title: input.title,
        executor: input.executor,
        executorType: (input as any).executorType,
        executorPhase: (input as any).executorPhase,
        success: input.success,
        errorMessage: input.errorMessage,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        durationMs: input.durationMs,
        iteration: input.iteration,
        output: normalized,
      };
      this.steps.push(step);
    } catch (e) {
      // Never throw from collector; just log and continue
      debugLog('SummaryCollector.addStepResult error: %o', e);
      this.errors.push(`Failed to add step result: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  setBatchIterations(iterations: number): void {
    try {
      if (Number.isFinite(iterations) && iterations > 0) {
        this.batchIterations = Math.floor(iterations);
      }
    } catch {
      // ignore
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
      // Ensure baseline exists; compute on-demand if needed
      if (!this.baselineRevision) {
        try {
          this.baselineRevision = await getCurrentCommitHash(gitRoot);
        } catch {
          // ignore; will fall back below
        }
      }
      let files: string[];
      if (this.baselineRevision) {
        files = await getChangedFilesBetween(gitRoot, this.baselineRevision);
      } else {
        // Fallback to previous behavior when baseline not available
        files = await getChangedFilesOnBranch(gitRoot);
      }
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
        batchIterations: this.batchIterations,
      },
      planInfo: {
        planId: this.init.planId,
        planTitle: this.init.planTitle,
        planFilePath: this.init.planFilePath,
      },
    };
  }
}
