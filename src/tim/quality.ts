import type { TimConfig } from './configSchema.js';

/** Keep production prompts unchanged when quality is omitted or explicitly production. */
export function appendQualityGuidance(prompt: string, quality: TimConfig['quality']): string {
  if (quality !== 'hobby') {
    return prompt;
  }

  return `${prompt}

## Quality: hobby

Apply these quality requirements to planning, implementation, testing, advice, and review. They qualify general instructions about exhaustive testing, edge cases, and production hardening.

- Correctness for the intended use, good code style, clear structure, and maintainability remain required. Preserve visual fidelity when the task includes a visual design.
- Prefer a simple, working implementation. Do not require production-level defenses against rare race conditions, malformed inputs outside the intended use, or other speculative failure cases unless the task explicitly requires them.
- Test the required behavior and errors that matter for the intended use. Do not expand the task with exhaustive defensive tests or infrastructure only for hypothetical production conditions.
- In reviews, report defects that affect the required behavior. Do not report missing production hardening alone as an issue or require it before approval.
- Follow explicit task requirements and preserve existing protections. Fix security or data-loss defects that affect the intended use.
- Pass these quality requirements to any agents you instruct.`;
}
