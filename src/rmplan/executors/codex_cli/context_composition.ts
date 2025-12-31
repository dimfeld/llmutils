import { FAILED_PROTOCOL_INSTRUCTIONS } from '../claude_code/agent_prompts';
import { progressSectionGuidance } from '../claude_code/orchestrator_prompt';

export function composeTesterContext(
  originalContext: string,
  implementerOutput: string,
  newlyCompletedTitles: string[]
): string {
  const tasksSection = newlyCompletedTitles.length
    ? `\n\n### Newly Completed Tasks\n- ${newlyCompletedTitles.join('\n- ')}`
    : '';
  return `${originalContext}\n\n### Implementer Output\n${implementerOutput}${tasksSection}`;
}

export function composeReviewerContext(
  originalContext: string,
  implementerOutput: string,
  testerOutput: string,
  completedTitles: string[],
  pendingTitles: string[]
): string {
  const completedSection = completedTitles.length
    ? `\n\n### Completed Tasks\n- ${completedTitles.join('\n- ')}`
    : '';
  const pendingSection = pendingTitles.length
    ? `\n\n### Pending Tasks\n- ${pendingTitles.join('\n- ')}`
    : '';
  const base =
    `${originalContext}` +
    `${completedSection}` +
    `${pendingSection}` +
    `\n\n### Initial Implementation Output\n${implementerOutput}` +
    `\n\n### Initial Testing Output\n${testerOutput}`;
  return base;
}

export function composeVerifierContext(
  originalContext: string,
  implementerOutput: string,
  newlyCompletedTitles: string[],
  previouslyCompletedTitles: string[],
  pendingTitles: string[]
): string {
  const previouslyCompletedSection = previouslyCompletedTitles.length
    ? `\n\n### Completed Tasks Before This Run\n- ${previouslyCompletedTitles.join('\n- ')}`
    : '';
  const pendingSection = pendingTitles.length
    ? `\n\n### Pending Tasks Prior to Verification\n- ${pendingTitles.join('\n- ')}`
    : '';
  const newlyCompletedSection = newlyCompletedTitles.length
    ? `\n\n### Newly Completed Tasks From Implementer\n- ${newlyCompletedTitles.join('\n- ')}`
    : '';
  return (
    `${originalContext}` +
    previouslyCompletedSection +
    pendingSection +
    newlyCompletedSection +
    `\n\n### Implementer Output Summary\n${implementerOutput}`
  );
}

export function composeFixReviewContext(
  originalContext: string,
  implementerOutput: string,
  testerOutput: string,
  completedTitles: string[],
  pendingTitles: string[],
  previousReview: string,
  fixerOutput: string,
  customInstructions?: string,
  planId?: string | number,
  planFilePath?: string
) {
  const baseContext = composeReviewerContext(
    originalContext,
    implementerOutput,
    testerOutput,
    completedTitles,
    pendingTitles
  );

  const customInstructionsSection = customInstructions
    ? `\n\n## Project-Specific Review Guidelines\n\n${customInstructions}`
    : '';

  const taskCompletionInstructions = planId
    ? `\n\n## Marking Tasks as Done

IMPORTANT: When you provide a verdict of ACCEPTABLE, you MUST mark the completed tasks as done using the rmplan set-task-done command. Use the task titles from the plan to identify which tasks to mark complete.

For example:
\`\`\`bash
rmplan set-task-done ${planId} --title "Task Title Here"
\`\`\`

Do this for each task that was successfully implemented and reviewed before providing your ACCEPTABLE verdict.`
    : '';
  const progressGuidance = progressSectionGuidance(planFilePath, { useAtPrefix: false });

  return `You are a fix verification assistant focused on determining whether previously identified issues have been adequately addressed by the implementer's fixes.

Your job is to verify that specific issues flagged in the previous review have been resolved, NOT to conduct a full new code review. Focus exclusively on whether the fixes address the concerns that were raised.

${baseContext}${customInstructionsSection}${taskCompletionInstructions}
${progressGuidance}

## Previous Review Issues

The following issues were identified in the initial review:

${previousReview}

## Implementer's Response to Review

The implementer attempted to address these issues with the following changes:

${fixerOutput}

## Your Verification Task

For each issue identified in the previous review, determine:

1. **Was the issue actually addressed?**
   - Did the implementer make the requested changes?
   - Are the changes sufficient to resolve the underlying problem?
   - Do the changes align with what was requested in the review?

2. **Are there valid reasons if an issue wasn't addressed?**
   - Technical constraints that make the fix impractical
   - Misunderstanding that should be clarified
   - Issue was actually not applicable to the current scope

3. **Did the fixes introduce new problems?**
   - Breaking changes to existing functionality
   - New bugs or regressions
   - Violations of project patterns or conventions

## Critical Focus Areas

### Issues That MUST Be Addressed (mark as NEEDS_FIXES if not resolved):
- **Security vulnerabilities** that were flagged
- **Correctness bugs** and logic errors
- **Critical performance issues** that affect system stability
- **Resource leaks** (memory, files, connections)
- **Type safety violations** that could cause runtime errors

### Issues That Can Be Acceptable If Explained:
- Style or formatting concerns (if consistent with codebase)
- Minor performance optimizations (if impact is negligible)
- Pattern deviations (if there's a clear justification)
- Documentation gaps (if not critical for functionality)

### Red Flags in Implementer Response:
- Dismissing legitimate security concerns without proper mitigation
- Ignoring correctness issues or claiming they don't matter
- Making changes that don't actually address the root problem
- Introducing new bugs while fixing old ones
- Unclear or evasive explanations for not addressing issues

## Verification Guidelines

- **Be specific**: Reference exact issues from the previous review
- **Check actual fixes**: Verify the implementer actually made the claimed changes
- **Assess completeness**: Ensure fixes address the root cause, not just symptoms
- **Consider scope**: Issues outside the current task scope may be acceptable to defer
- **Validate explanations**: If an issue wasn't fixed, the reason should be technically sound

## Response Format:

For each major issue from the previous review, provide:

**Issue**: [Brief description of the original concern]
**Status**: RESOLVED | NOT_ADDRESSED | PARTIALLY_ADDRESSED
**Assessment**: [Your verification of whether the fix is adequate]

Additional concerns (if any new issues were introduced by the fixes):
- CRITICAL: [Any new critical issues introduced by the fixes]
- MAJOR: [Any new significant problems created]

**VERDICT:** NEEDS_FIXES | ACCEPTABLE

## Response Format Notes:

For the verdict:
- **NEEDS_FIXES**: Use when critical issues remain unresolved or new critical issues were introduced
- **ACCEPTABLE**: Use when all critical issues have been adequately addressed, even if minor issues remain

If NEEDS_FIXES: Focus on what specifically still needs to be resolved from the original review
If ACCEPTABLE: Briefly confirm that the major concerns have been addressed
`;
}

/** Build a prompt for the fixer step */
export function getFixerPrompt(input: {
  planPath?: string;
  planId?: string | number;
  implementerOutput: string;
  testerOutput: string;
  completedTaskTitles: string[];
  fixInstructions: string;
}): string {
  const tasks = input.completedTaskTitles.length
    ? `- ${input.completedTaskTitles.join('\n- ')}`
    : '(none)';
  const progressGuidance = progressSectionGuidance(input.planPath, { useAtPrefix: false });
  return `You are a fixer agent focused on addressing reviewer-identified issues precisely and minimally.

Context:
## Completed Tasks (in scope)
${tasks}

## Initial Implementation Notes
${input.implementerOutput}

## Testing Agent Output
${input.testerOutput}

## Review Instructions
${input.fixInstructions}

Your job:
1. Make only the changes required to satisfy the fix instructions
2. Follow repository conventions and type safety
3. Prefer small, safe changes; avoid broad refactors
4. Run relevant tests and commands as needed

${progressGuidance}

When complete, summarize what you changed. If you could not address an issue, clearly explain why.

${FAILED_PROTOCOL_INSTRUCTIONS}`;
}
