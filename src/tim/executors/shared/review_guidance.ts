import { REVIEW_SEVERITY_RUBRIC } from '../../review_severity.js';
import type { OrchestrationOptions } from './orchestration_options.js';

export function structuralPassApplies(options: OrchestrationOptions): boolean {
  return options.batchMode === true && options.structuralReviewCompleted !== true;
}

function reviewCommandName(options: OrchestrationOptions): string {
  return options.agentMessagingEnabled === true ? 'tim review' : 'tim subagent reviewer';
}

export function buildReviewCommand(planId: string, options: OrchestrationOptions): string {
  const commandName = reviewCommandName(options);
  const baseCommand = `${commandName} ${planId} --print --output-file <output_path>`;
  if (options.reviewExecutor) {
    return `${baseCommand} --executor ${options.reviewExecutor}`;
  }
  return baseCommand;
}

export function buildFullPlanReviewCommand(planId: string, options: OrchestrationOptions): string {
  return `${reviewCommandName(options)} ${planId} --print --output-file <output_path>`;
}

export function buildReviewRejectionGuidance(planId: string): string {
  return `After each rejection, immediately record the finding with \`tim review-issues reject ${planId} --from-review <output.json> --issue <n> --reason "..."\`. When a finding is valid but non-blocking, record it instead with \`tim review-issues reject ${planId} --from-review <output.json> --issue <n> --state non-blocking --reason "..."\`. If multiple findings in the same review describe the same underlying issue, record only one disposition; do not add a separate rejected issue for a duplicate. This often happens when different reviewer subagents report the same issue. Use the same \`<output.json>\` path passed to the reviewer's \`--output-file\` and the finding's 1-based index in that output. Later reviews load these dispositions automatically, so do not re-type them.`;
}

/**
 * The orchestrator-owned per-batch review produces no reviewer `--output-file`, so `--from-review`
 * has nothing to read. Recording those rejections still matters: without it, the final full-plan
 * reviewer re-raises findings the orchestrator already settled.
 */
export function buildBatchReviewRejectionGuidance(planId: string): string {
  return `   - When you reject one of your own batch-review findings, record it with \`tim review-issues reject ${planId} --content "<the finding>" --file <path> --line <line> --reason "..."\`. When it is valid but non-blocking, add \`--state non-blocking\` instead. If multiple findings in the same review describe the same underlying issue, record only one disposition; do not add a separate rejected issue for a duplicate. This often happens when different reviewer subagents report the same issue. This review produces no reviewer output file, so use the explicit fields rather than \`--from-review\`. Recording it keeps the final full-plan review from re-raising a finding you already settled.`;
}

/**
 * Shared policy for an ordinary task-scoped formal review phase.
 *
 * The review command and delegation wording vary by orchestration mode, but rejection
 * recording and reviewer task scope must remain identical in every prompt.
 */
export function buildFormalReviewScopeGuidance(planId: string): string {
  return `   - ${buildReviewRejectionGuidance(planId)}
   - Scope the review to the tasks you worked on using \`--task-index\` (1-based). Pass each task index separately: \`--task-index 1 --task-index 3\` for tasks 1 and 3.`;
}

function buildStructuralReviewCommand(planId: string, options: OrchestrationOptions): string {
  return `${reviewCommandName(options)} ${planId} --print --output-file <output_path> --structural-only`;
}

const CLOSING_FULL_SCOPE_REVIEW_GUIDANCE: string =
  'The closing full-scope review is the last ordinary review inside the four-review budget, never an extra review. If a diff-scoped review would otherwise be terminal, run the closing review in the next available budget slot. If the bound is reached, review #4 is the closing full-scope review, so leave that slot for it instead of spending it on a diff-scoped review. If the review that turns out to be terminal was already full scope, it IS the closing review: do not add another one.';

type ReviewFixVerificationScope = 'full-plan' | 'task-index';

const REVIEW_COMMIT_HASH_CAPTURE_GUIDANCE: string =
  'record the current commit hash with `git rev-parse HEAD` (or `jj log --no-graph -r @- -T commit_id` in a Jujutsu workspace)';

/**
 * Renders the fix-verification review invocation shared by the three places that describe
 * tier (2) of the review scope rule. Only the review command and the scope flag genuinely
 * differ between call sites; the prose is deliberately identical so the policy reads the
 * same wherever it appears.
 */
function buildReviewFixVerificationInvocation(
  reviewCommand: string,
  scope: ReviewFixVerificationScope,
  options: OrchestrationOptions
): string {
  const scopeGuidance: string =
    scope === 'full-plan'
      ? 'and the same full-plan scope (no `--task-index`)'
      : 'plus the same `--task-index` scope';
  const findingContextGuidance: string =
    options.agentMessagingEnabled === true
      ? 'and include the specific findings being re-checked in the review command context'
      : 'and enumerate in `--input` the specific findings being re-checked';
  return `\`${reviewCommand}\` with \`--since <that commit>\` ${scopeGuidance}, ${findingContextGuidance}`;
}

export function buildFinalBatchReviewGuidance(
  planId: string,
  options: OrchestrationOptions
): string {
  if (!options.batchMode) {
    return '';
  }

  const structuralPassWillRun: boolean = structuralPassApplies(options);
  const reviewCommand = buildFullPlanReviewCommand(planId, options);
  const fixVerificationInvocation: string = buildReviewFixVerificationInvocation(
    reviewCommand,
    'full-plan',
    options
  );
  const postStructuralFixGuidance = structuralPassWillRun
    ? ' The post-structural validation review, when needed, is a separate full-plan exception after the structural pass.'
    : '';
  const postStructuralRejectionGuidance = structuralPassWillRun
    ? ', including the post-structural validation review'
    : '';
  const ordinaryFinalPlanReviewGuidance = `
   - If the selected batch finishes all remaining tasks in the plan, enter the final-plan review sequence. Review #1 is the full-plan bookend: run \`${reviewCommand}\` without any \`--task-index\` or \`--since\` arguments so the entire completed plan state is reviewed before you stop. This ordinary review must inspect the entire completed plan scope.
   - If that full-plan review reports blocking issues, follow the Review Iteration Policy below. The ordinary final-plan sequence follows the same three tiers under its own separate four-review budget, counted independently of any orchestrator-owned per-batch reviews: intermediate fix-verification reruns 2..n immediately before applying fixes ${REVIEW_COMMIT_HASH_CAPTURE_GUIDANCE}, then run ${fixVerificationInvocation}. ${CLOSING_FULL_SCOPE_REVIEW_GUIDANCE} This gives fresh eyes twice.${postStructuralFixGuidance}
   - ${buildReviewRejectionGuidance(planId)} This applies to every ordinary review in this final-plan sequence${postStructuralRejectionGuidance}.
`;

  if (!structuralPassWillRun) {
    return (
      ordinaryFinalPlanReviewGuidance +
      `   - The standalone structural simplification pass has already run for this plan, so this run has no structural pass and no post-structural validation review. ${options.agentMessagingEnabled === true ? 'Do not run a collaborative agent for the structural pass or improvise a substitute structural or simplification pass.' : 'Do not run `tim subagent reviewer` with `--structural-only`, and do not improvise a substitute structural or simplification pass.'} Stop when the ordinary review loop reaches a Review Iteration Policy stopping condition.
   - Any review findings related to previous tasks in this plan should still be considered, even if those tasks were not performed in this batch of work. The idea is a final quality pass on the entire plan.
`
    );
  }

  const structuralCommand = buildStructuralReviewCommand(planId, options);
  return (
    ordinaryFinalPlanReviewGuidance +
    `   - Only after the ordinary full-plan review loop has reached a Review Iteration Policy stopping condition—no new blocking findings, or the bounded handoff completed—run exactly one standalone structural simplification pass with \`${structuralCommand}\`, again without \`--task-index\`. Use it to find code-layout, ownership, duplication, and structural smells.
   - The cascade "consolidation proposal" in the Review Iteration Policy is unrelated to this standalone \`--structural-only\` structural pass.
   - Resolve the structural findings you accept and run relevant targeted checks. If you make structural changes, run exactly one complete ordinary review afterward to validate the resulting plan state, even if four ordinary reviews already ran before the structural pass. This post-structural validation review is an explicit exception to the ordinary review run limit.
   - Do not restart the ordinary review loop after the post-structural validation review. Reject incorrect findings from that review with evidence and capture each remaining finding worth fixing in a follow-up task using the bounded handoff procedure.
   - Do not rerun the structural pass automatically.
   - Any review findings related to previous tasks in this plan should still be considered, even if those tasks were not performed in this batch of work. The idea is a final quality pass on the entire plan.
`
  );
}

/**
 * Indents every non-empty line of a block so it nests under the bullet that introduces it.
 * Blank lines stay empty so the markdown list is not broken by trailing whitespace.
 */
function indentBlock(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `${indent}${line}` : line))
    .join('\n');
}

export function buildReviewIterationGuidance(
  reviewCommand: string,
  options: OrchestrationOptions
): string {
  const orchestratorReviewsBatch: boolean = options.batchMode === true;
  const structuralPassWillRun: boolean = structuralPassApplies(options);
  const taskFixVerificationInvocation: string = buildReviewFixVerificationInvocation(
    reviewCommand,
    'task-index',
    options
  );
  const finalPlanFixVerificationInvocation: string = buildReviewFixVerificationInvocation(
    reviewCommand,
    'full-plan',
    options
  );
  const reviewScopeGuidance = orchestratorReviewsBatch
    ? `- For selected-task batch review passes, perform the review yourself. You may use your own native subagent mechanism as an aid, but do not invoke ${options.agentMessagingEnabled === true ? 'the one-shot formal review command' : '`tim subagent reviewer`'}.
- When the batch completes all remaining plan tasks, the separate final full-plan sequence follows the same three tiers under its own separate four-review budget, counted independently of the orchestrator-owned per-batch reviews above: review #1 is full-plan with \`${reviewCommand}\` and no \`--task-index\` or \`--since\`; intermediate reruns 2..n are fix-verification reviews, so immediately before applying fixes ${REVIEW_COMMIT_HASH_CAPTURE_GUIDANCE} and then run ${finalPlanFixVerificationInvocation}. ${CLOSING_FULL_SCOPE_REVIEW_GUIDANCE} This is fresh eyes twice.`
    : `- Apply this budgeted three-tier scope rule to ordinary reviews. (1) The first ordinary review of a task batch covers the full declared scope: run \`${reviewCommand}\` with the same \`--task-index\` scope you worked on and no \`--since\`. (2) Intermediate fix-verification reviews are diff-scoped: immediately BEFORE applying fixes, ${REVIEW_COMMIT_HASH_CAPTURE_GUIDANCE}; after the fixes, run ${taskFixVerificationInvocation}. (3) Whenever the loop is about to stop because a complete review produced no new blocking findings or because the four-review bound is reached, the final review within the four-review budget is full declared scope again with no \`--since\`. ${CLOSING_FULL_SCOPE_REVIEW_GUIDANCE} This preserves full-scope fresh eyes at both bookends of the loop.`;
  const repeatReviewGuidance = orchestratorReviewsBatch
    ? '- After an accepted blocking consolidation change or other blocking fix, run relevant targeted checks and repeat your orchestrator-owned review. During the final full-plan sequence, use its full-plan, diff-scoped fix-verification, and full-plan bookend tiers.'
    : `- After an accepted blocking consolidation change, rerun \`${reviewCommand}\` according to the three-tier scope rule above.
- After accepted blocking fixes, run relevant targeted checks and repeat the ordinary review according to those scope tiers.`;
  // When the marker is set, neither the standalone structural pass nor its single post-structural
  // validation review runs, so no sentence in this policy may describe or authorize them. Each
  // fragment below is the conditional part only: stating the shared sentence once keeps the two
  // marker states from drifting apart, which is how the earlier duplicated wording went stale.
  // The first fragment leads with `\n` rather than being a blank bullet, because a blank line here
  // would split the policy into two markdown lists.
  const structuralReviewGuidance = structuralPassWillRun
    ? `\n- This gate applies to ordinary-review findings only. Findings from the standalone \`--structural-only\` structural pass are handled by that pass's instructions instead: accepting and fixing those findings, plus its single post-structural validation review, is expected and is not a gate violation.
- The post-structural validation review is outside the ordinary iteration loop. Its blocking findings do not trigger an in-loop fix or another ordinary review; handle them through the bounded handoff below instead by rejecting them with evidence or capturing them as follow-up tasks.`
    : '';
  const structuralValidationReviewAllowance = structuralPassWillRun
    ? ' A single ordinary review used to validate changes from the standalone structural pass is allowed in addition to this limit.'
    : '';
  const structuralValidationReviewHandoff = structuralPassWillRun
    ? ' and any post-structural validation review'
    : '';
  const reviewLimitGuidance = `- Allow at most 4 ordinary review runs per task batch during this iteration loop. The limit bounds iterative review execution; it does not mean that remaining feedback should be discarded.${structuralValidationReviewAllowance}`;
  const finalHandoffGuidance = `- Once targeted checks pass and every finding from the fourth review${structuralValidationReviewHandoff} has been rejected or captured in a follow-up task, mark the original in-scope tasks done and complete the batch.`;
  const reviewFixScopeGuidance =
    options.agentMessagingEnabled === true
      ? `- Scope every review-fix agent assignment with StartAgent or SendAgentMessage. Include the owning task, exact file scope, accepted findings, constraints, and verification in the initial or follow-up message. Keep the fix within that scope and use the canonical agent name returned by StartAgent or ListAgents.
- If the owning task is already complete, describe the completed-task finding and its file scope in the message rather than changing plan task state.
- Scope only review-fix assignments. Initial implementation, TDD test, and testing assignments use their normal task and file scope; do not create a review-fix assignment until the finding is accepted.`
      : `- Scope every review-fix subagent run. When you dispatch a subagent to fix review findings, pass repeatable or comma-separated \`--task-index\` values for exactly the task(s) that own the findings. The indexes are plan-absolute and 1-based, numbered over every plan task including completed ones, the same numbering the reviewer's \`--task-index\` uses. Include the findings being fixed in \`--input\` or \`--input-file\`, and instruct the subagent not to touch code outside those findings.
- Unlike the reviewer, a subagent \`--task-index\` accepts only tasks that are still incomplete; an index naming a completed task fails the command. If the task that owns a finding is already marked done—common in the final full-plan sequence, where earlier iterations have already completed their tasks—omit \`--task-index\` entirely and state the scope of the fix in \`--input\` instead. Never mark a task incomplete to work around this.
- Scope only fix rounds. The first implementation, TDD-test, and testing run of a batch covers the tasks you selected and passes no \`--task-index\`; only a run that fixes review findings is scoped.`;
  return `## Review Iteration Policy

${reviewScopeGuidance}
- Treat each complete review as capable of finding issues earlier passes missed. After each review, fix every blocking finding you accept and reject any incorrect finding with a concrete, evidence-based explanation. A finding that has been neither fixed, rejected, nor captured as a follow-up is unhandled.
- Use the reviewer severity as a default signal when deciding whether a finding blocks completion; it is not a fixed gate. Consider the actual impact, evidence, scope, and plan context before making the decision. The shared calibrated reviewer rubric below defines the four severity labels:
${indentBlock(REVIEW_SEVERITY_RUBRIC, '  ')}
- A \`critical\` or \`major\` finding normally blocks and a \`minor\` or \`info\` finding normally does not, but you may override that default when the evidence and context justify it. Fix accepted blocking findings in-loop. Record valid findings you decide are non-blocking with the \`non-blocking\` state and a concrete reason, or capture them immediately as follow-up tasks through the bounded-handoff wording below. Findings that you decide are non-blocking must NEVER by themselves trigger an implementer round or another review rerun. At the end of the terminal review loop, fix every straightforward non-blocking finding and delete its saved review issue after verification. The reviewer's JSON output already carries a \`severity\` field per issue; for legacy free-text output, use \`CRITICAL\`/\`MAJOR\` as a default blocking signal and \`MINOR\` as a default non-blocking signal. When you perform a review yourself rather than running the reviewer command, assign one of the same four severities before making the context-based decision.${structuralReviewGuidance}
- Compare each new review result with the actual substance and cause of prior findings; do not rely only on category labels or filenames. Decide whether it is the same underlying defect, a different issue exposed by the fix, or a regression introduced by the fix. Keep this recurrence judgment in your own working notes; the review command does not classify it for you.
- Watch for cascading findings: the same underlying defect recurring, a fix exposing another defect in the same responsibility boundary, or repeated fixes moving the problem between duplicated implementations.
- On the FIRST review that reports the same defect class at multiple locations—the reviewer now surfaces this up front as one multi-location finding—treat it as the cascade signal. Do not wait for a second occurrence across rounds. Pause instance-by-instance patching; as the orchestrator, inspect the implementation and prior findings yourself, identify the failed invariant, duplicated responsibility, or ownership problem, and write a concrete consolidation proposal before delegating more implementation.
- This root-cause checkpoint is orchestrator analysis, not a separate review mode and not a request for the reviewer to solve a difficult bug. Prefer correcting the shared structure or consolidating responsibility when that addresses the cause. Pass the consolidation proposal and the relevant findings to the implementer as ONE consolidated instruction instead of per-instance fixes.
${reviewFixScopeGuidance}
${repeatReviewGuidance}
- Stop the ordinary review loop when either:
  1. targeted checks pass and a complete ordinary review produces no new blocking findings; a review whose only unhandled findings are non-blocking is terminal; or
  2. the fourth ordinary review has completed and the bounded handoff procedure below has been completed.
${reviewLimitGuidance}
- After the fourth ordinary review, do not run another ordinary review as part of this iteration loop. For every remaining finding, either reject it with a concrete, evidence-based explanation or create a specific follow-up task if it is worth fixing.
- New blocking findings extend the loop until the four-review bound. A finding captured in a follow-up task is handled for purposes of completing this batch. Include the original finding, relevant files or locations, why it matters, and any consolidation analysis or proposed consolidation discovered during this review cycle.
- **Be careful where you file follow-up work:** adding it to the current plan means the harness may select it in a later iteration of this plan. When you file a finding as a follow-up task with \`tim add-task\`, always pass \`--review-follow-up\` so the task is marked as review cleanup and the completed-structural-review marker is not cleared, which would re-trigger the full final review sequence. If it depends on work scheduled for a later sibling plan, add it to that existing sibling plan instead. In rare cases, feedback that genuinely belongs at the end of the entire sibling-plan chain may require a new sibling plan.
${finalHandoffGuidance}
`;
}
