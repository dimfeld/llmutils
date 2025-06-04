// Command handler for 'rmplan split'
// Uses LLM to intelligently split a large plan into smaller, phase-based plans with dependencies

import * as path from 'path';
import chalk from 'chalk';
import yaml from 'yaml';
import { error, log } from '../../logging.js';
import { createModel } from '../../common/model_factory.js';
import { runStreamingPrompt } from '../../common/run_and_apply.js';
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

export async function handleSplitCommand(planArg: string, options: any) {
  const globalOpts = options.parent.opts();

  try {
    // Step 1: Resolve the input plan file path
    const resolvedPlanFile = await resolvePlanFile(planArg, globalOpts.config);

    // Step 2: Read and validate the plan file
    let validatedPlan: PlanSchema;
    try {
      validatedPlan = await readPlanFile(resolvedPlanFile);
    } catch (err) {
      error(`Failed to read or validate plan file '${resolvedPlanFile}': ${err as Error}`);
      process.exit(1);
    }

    // Step 3: Generate the prompt for splitting the plan
    log(chalk.blue('📄 Plan loaded successfully:'));
    log(`  Title: ${validatedPlan.title || 'No title'}`);
    log(`  Goal: ${validatedPlan.goal}`);
    if (validatedPlan.tasks) {
      log(`  Tasks: ${validatedPlan.tasks.length}`);
    }

    // Step 6: Load configuration and generate the prompt
    const splitConfig = await loadEffectiveConfig(globalOpts.config);
    const prompt = generateSplitPlanPrompt(validatedPlan);

    // Step 7: Call the LLM to reorganize the plan
    log(chalk.blue('\n🤖 Analyzing plan structure and identifying logical phases...'));
    const modelSpec = splitConfig.models?.stepGeneration || 'google/gemini-2.0-flash';
    const model = createModel(modelSpec);

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
      error('Check your model configuration and API credentials.');
      process.exit(1);
    }

    // Step 8: Extract and parse the YAML from the LLM response
    log(chalk.blue('\n📝 Processing LLM-generated phase structure...'));
    let parsedMultiPhase: any;
    let cleanedYaml: string;
    try {
      const yamlContent = findYamlStart(llmResponse);
      cleanedYaml = fixYaml(yamlContent);
      parsedMultiPhase = yaml.parse(cleanedYaml);
    } catch (err) {
      error(`Failed to parse multi-phase plan from LLM response: ${err as Error}`);

      // Save raw response for debugging
      const debugFile = 'rmplan-split-raw-response.yml';
      await Bun.write(debugFile, llmResponse);
      error(`\nRaw LLM response saved to ${debugFile} for debugging.`);
      process.exit(1);
    }

    // Step 9: Validate the multi-phase plan structure
    const validationResult = multiPhasePlanSchema.safeParse(parsedMultiPhase);

    if (!validationResult.success) {
      error(
        'Multi-phase plan validation failed. The LLM output does not match expected structure:'
      );
      validationResult.error.issues.forEach((issue) => {
        error(`  - ${issue.path.join('.')}: ${issue.message}`);
      });

      // Save invalid YAML for debugging
      const debugFile = 'rmplan-split-invalid.yml';
      await Bun.write(debugFile, cleanedYaml);
      error(`\nInvalid YAML saved to ${debugFile} for debugging.`);
      process.exit(1);
    }

    // Step 10: Process the validated multi-phase plan
    const multiPhasePlan = validationResult.data;
    log(chalk.green('\n✓ Successfully reorganized plan into phases:'));
    log(`  Total phases: ${multiPhasePlan.phases.length}`);
    multiPhasePlan.phases.forEach((phase, index) => {
      log(`  Phase ${index + 1}: ${phase.title || 'Untitled'} (${phase.tasks.length} tasks)`);
    });

    // Step 11: Save the multi-phase plan using saveMultiPhaseYaml
    // Determine output directory path
    const outputDir = path.join(
      path.dirname(resolvedPlanFile),
      path.basename(resolvedPlanFile, path.extname(resolvedPlanFile))
    );

    // Prepare options for saveMultiPhaseYaml
    const extractOptions: ExtractMarkdownToYamlOptions = {
      output: outputDir,
      projectId: validatedPlan.id,
      issueUrls: validatedPlan.issue,
    };

    // Call saveMultiPhaseYaml
    const quiet = false;
    const message = await saveMultiPhaseYaml(multiPhasePlan, extractOptions, splitConfig, quiet);

    // Log the result message
    log(message);
  } catch (err) {
    error(`Unexpected error while splitting plan: ${err as Error}`);
    process.exit(1);
  }
}
