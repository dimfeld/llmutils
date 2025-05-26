import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { generateText } from 'ai';
import { createModel } from '../../common/model_factory.js';
import { getInstructionsFromGithubIssue } from '../../common/github/issues.js';
import { planPrompt } from '../../rmplan/prompt.js';
import { runRmfilterProgrammatically } from '../../rmfilter/rmfilter.js';
import { extractMarkdownToYaml } from '../../rmplan/actions.js';
import { argsFromRmprOptions, type RmprOptions } from '../../rmpr/comment_options.js';
import { config as botConfig } from '../config.js';
import { loadEffectiveConfig as loadRmplanRepoConfig } from '../../rmplan/configLoader.js';
import { getGitRoot } from '../../rmfilter/utils.js';
import { log, error, debugLog, warn } from '../../logging.js';

interface PlanGenerationResult {
  planYamlPath: string;
  planYamlContent: string;
  planMarkdownContent: string;
}

export async function generatePlanForIssue(
  issueUrl: string,
  taskId: string,
  repoPath: string
): Promise<PlanGenerationResult> {
  log(`[${taskId}] Starting plan generation for issue: ${issueUrl}`);

  // 1. Fetch issue content and parse rmpr options
  const issueDetails = await getInstructionsFromGithubIssue(issueUrl);
  let planRequestText = issueDetails.plan;
  const rmprOptions = issueDetails.rmprOptions;

  debugLog(`[${taskId}] Fetched issue content. Title: ${issueDetails.issue.title}`);

  // 2. Construct the prompt for the planning LLM (the one that creates the structured plan)
  const llmPlanningPrompt = planPrompt(planRequestText);
  const tempPlanPromptFile = path.join(os.tmpdir(), `rmplan-gh-bot-prompt-${taskId}.md`);
  await fs.writeFile(tempPlanPromptFile, llmPlanningPrompt);
  debugLog(`[${taskId}] Wrote LLM planning prompt to ${tempPlanPromptFile}`);

  // 3. Prepare rmfilter arguments
  // For plan generation, rmfilter's main purpose is context gathering for the planning LLM.
  // It needs the `llmPlanningPrompt` as its instructions.
  let rmfilterArgs: string[] = ['--instructions', `@${tempPlanPromptFile}`];
  if (rmprOptions) {
    // Convert RmprOptions to rmfilter args for file selection/context
    // Note: argsFromRmprOptions might need the PR object if `pr:` prefixes are used.
    // For initial plan generation from an issue, PR object is not available.
    // We'll assume rmprOptions from issues mostly use direct file paths or general globs.
    const issueContextArgs = argsFromRmprOptions(rmprOptions /*, optional PR object */);
    if (issueContextArgs.length > 0) {
      rmfilterArgs.push('--');
      rmfilterArgs.push(...issueContextArgs);
    }
  }

  // 4. Run rmfilter to get context for the planning LLM
  log(`[${taskId}] Running rmfilter to gather context...`);
  // runRmfilterProgrammatically needs gitRoot and baseDir.
  // For a bot processing a plan for a specific repo, `repoPath` should be the git root of that repo.
  const rmfilterOutput = await runRmfilterProgrammatically(rmfilterArgs, repoPath, repoPath);
  debugLog(`[${taskId}] rmfilter output length: ${rmfilterOutput.length}`);
  await fs
    .unlink(tempPlanPromptFile)
    .catch((e) => warn(`[${taskId}] Failed to delete temp prompt file: ${e.message}`));

  // 5. Call the LLM to generate the plan structure (in Markdown)
  log(`[${taskId}] Calling LLM to generate plan structure...`);
  const rmplanRepoConfig = await loadRmplanRepoConfig();
  const planningModel =
    rmplanRepoConfig.models?.execution ||
    botConfig.PLANNING_MODEL ||
    'google/gemini-2.5-pro-preview-05-06';

  const llm = createModel(planningModel);
  const llmResponse = await generateText({
    model: llm,
    prompt: rmfilterOutput,
  });
  const planMarkdownContent = llmResponse.text;
  debugLog(`[${taskId}] LLM generated plan Markdown length: ${planMarkdownContent.length}`);

  // 6. Convert the LLM's Markdown plan to YAML
  log(`[${taskId}] Converting generated Markdown plan to YAML...`);
  // extractMarkdownToYaml uses a model specified in rmplan.yml (convert_yaml) or a default
  const planYamlContent = await extractMarkdownToYaml(
    planMarkdownContent,
    rmplanRepoConfig,
    true /* quiet */
  );
  debugLog(`[${taskId}] Converted YAML plan length: ${planYamlContent.length}`);

  // 7. Save the YAML plan
  // The plan should be saved in a structured way, e.g., WORKSPACE_BASE_DIR/tasks/<task_id>/plan.yml
  const planDir = path.join(botConfig.WORKSPACE_BASE_DIR, 'tasks', taskId, 'plans');
  await fs.mkdir(planDir, { recursive: true });
  const planYamlPath = path.join(planDir, 'plan.yml');
  await fs.writeFile(planYamlPath, planYamlContent);
  log(`[${taskId}] Saved generated YAML plan to: ${planYamlPath}`);

  // Also save the markdown plan for auditing/debugging
  const planMarkdownPath = path.join(planDir, 'plan.md');
  await fs.writeFile(planMarkdownPath, planMarkdownContent);

  return { planYamlPath, planYamlContent, planMarkdownContent };
}
