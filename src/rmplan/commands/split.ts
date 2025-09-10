// Command handler for 'rmplan split'
// Uses LLM to intelligently split a large plan into smaller, phase-based plans with dependencies

import * as path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { error, log } from '../../logging.js';
import { createModel } from '../../common/model_factory.js';
import { runStreamingPrompt } from '../llm_utils/run_and_apply.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { readPlanFile, resolvePlanFile } from '../plans.js';
import { generateSplitPlanPrompt } from '../prompt.js';
import { multiPhasePlanSchema, type PlanSchema } from '../planSchema.js';
import {
  findYamlStart,
  saveMultiPhaseYaml,
  type ExtractMarkdownToYamlOptions,
} from '../process_markdown.js';
import { fixYaml } from '../fix_yaml.js';
import type { Command } from 'commander';

export async function handleSplitCommand(planArg: string, options: any, command: Command) {
  const globalOpts = command.parent!.opts();

  // Validate mutually exclusive modes
  const modeFlags = [options?.auto ? 'auto' : null, options?.tasks ? 'tasks' : null, options?.select ? 'select' : null].filter(
    Boolean
  ) as string[];

  if (modeFlags.length === 0) {
    throw new Error(
      'No mode specified. Choose one of: --auto (LLM-based), --tasks <specifier> (manual), or --select (interactive).'
    );
  }

  if (modeFlags.length > 1) {
    throw new Error('Options --auto, --tasks, and --select are mutually exclusive. Choose only one.');
  }

  // Step 1: Resolve the input plan file path
  const resolvedPlanFile = await resolvePlanFile(planArg, globalOpts.config);

  // Step 2: Read and validate the plan file
  let validatedPlan: PlanSchema;
  try {
    validatedPlan = await readPlanFile(resolvedPlanFile);
  } catch (err) {
    throw new Error(`Failed to read or validate plan file '${resolvedPlanFile}': ${err as Error}`);
  }

  if (options.auto) {
    // Existing LLM-based behavior
    log(chalk.blue('📄 Plan loaded successfully:'));
    log(`  Title: ${validatedPlan.title || 'No title'}`);
    log(`  Goal: ${validatedPlan.goal}`);
    if (validatedPlan.tasks) {
      log(`  Tasks: ${validatedPlan.tasks.length}`);
    }

    // Load configuration and generate the prompt
    const splitConfig = await loadEffectiveConfig(globalOpts.config);
    const prompt = generateSplitPlanPrompt(validatedPlan);

    // Call the LLM to reorganize the plan
    log(chalk.blue('\n🤖 Analyzing plan structure and identifying logical phases...'));
    const modelSpec = splitConfig.models?.stepGeneration || 'google/gemini-2.0-flash';
    const model = await createModel(modelSpec, splitConfig);

    let llmResponse: string;
    try {
      const llmResult = await runStreamingPrompt({
        model,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
      });
      llmResponse = llmResult.text;
    } catch (err) {
      error(`Failed to call LLM for plan splitting: ${err as Error}`);
      throw new Error('Check your model configuration and API credentials.');
    }

    // Extract and parse the YAML from the LLM response
    log(chalk.blue('\n📝 Processing LLM-generated phase structure...'));
    let parsedMultiPhase: any;
    try {
      const yamlContent = findYamlStart(llmResponse);
      const splitConfigLocal = splitConfig; // keep type narrowing stable
      parsedMultiPhase = await fixYaml(yamlContent, 5, splitConfigLocal);
    } catch (err) {
      error(`Failed to parse multi-phase plan from LLM response: ${err as Error}`);

      // Save raw response for debugging
      const debugFile = 'rmplan-split-raw-response.yml';
      await Bun.write(debugFile, llmResponse);
      throw new Error(`\nRaw LLM response saved to ${debugFile} for debugging.`);
    }

    // Validate the multi-phase plan structure
    const validationResult = multiPhasePlanSchema.safeParse(parsedMultiPhase);

    if (!validationResult.success) {
      error('Multi-phase plan validation failed. The LLM output does not match expected structure:');
      validationResult.error.issues.forEach((issue) => {
        error(`  - ${issue.path.join('.')}: ${issue.message}`);
      });

      // Save invalid YAML for debugging
      const debugFile = 'rmplan-split-invalid.yml';
      await Bun.write(debugFile, yaml.stringify(parsedMultiPhase));
      throw new Error(`\nInvalid YAML saved to ${debugFile} for debugging.`);
    }

    // Process the validated multi-phase plan
    const multiPhasePlan = validationResult.data;
    log(chalk.green('\n✓ Successfully reorganized plan into phases:'));
    log(`  Total phases: ${multiPhasePlan.phases.length}`);
    multiPhasePlan.phases.forEach((phase, index) => {
      log(`  Phase ${index + 1}: ${phase.title || 'Untitled'} (${phase.tasks.length} tasks)`);
    });

    // Save the multi-phase plan using saveMultiPhaseYaml
    const outputDir = path.join(
      path.dirname(resolvedPlanFile),
      path.basename(resolvedPlanFile, path.extname(resolvedPlanFile))
    );

    const extractOptions: ExtractMarkdownToYamlOptions = {
      output: outputDir,
      projectId: validatedPlan.id,
      issueUrls: validatedPlan.issue,
    };

    const quiet = false;
    const message = await saveMultiPhaseYaml(multiPhasePlan, extractOptions, splitConfig, quiet);
    log(message);
    return;
  }

  // Manual modes (to be implemented in subsequent tasks)
  if (options.tasks) {
    throw new Error(
      'Manual task-based split is not implemented yet in this phase. Use --auto or await the next update.'
    );
  }

  if (options.select) {
    throw new Error(
      'Interactive selection mode is not implemented yet in this phase. Use --auto or await the next update.'
    );
  }
}
