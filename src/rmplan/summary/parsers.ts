export type ParsedExecutorOutput = {
  success: boolean;
  content?: string;
  steps?: Array<{ title: string; body: string }>;
  metadata?: Record<string, unknown>;
  error?: string;
};

function isSteps(val: unknown): val is Array<{ title: string; body: string }> {
  return (
    Array.isArray(val) &&
    val.every(
      (s) =>
        s &&
        typeof s === 'object' &&
        typeof (s as any).title === 'string' &&
        typeof (s as any).body === 'string'
    )
  );
}

/**
 * Minimal parser/normalizer for executor outputs used by summary tests.
 * Accepts only structured objects of the shape `{ content: string, steps?: [...], metadata?: {...} }`.
 */
export function parseExecutorOutput(
  _executorName: string,
  raw: unknown
): ParsedExecutorOutput {
  if (!raw || typeof raw !== 'object') {
    return { success: false, error: 'Expected structured executor output object' };
  }
  const obj = raw as Record<string, unknown>;
  const content = typeof obj.content === 'string' ? obj.content : undefined;
  const metadata = obj.metadata && typeof obj.metadata === 'object' ? (obj.metadata as any) : undefined;
  const steps = isSteps((obj as any).steps) ? ((obj as any).steps as Array<{ title: string; body: string }>) : undefined;

  if (content == null && !steps) {
    return { success: false, error: 'Expected structured executor output with content or steps' };
  }

  return {
    success: true,
    content,
    steps,
    metadata,
  };
}

