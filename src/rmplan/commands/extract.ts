// Command handler for 'rmplan extract'
// Converts a Markdown project plan into YAML

import * as path from 'path';
import chalk from 'chalk';
import * as clipboard from '../../common/clipboard.ts';
import { error, log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { readPlanFile } from '../plans.js';
import { extractMarkdownToYaml, type ExtractMarkdownToYamlOptions } from '../process_markdown.js';
import { setQuiet } from '../../common/process.ts';
import type { PlanSchema } from '../planSchema.js';

export async function handleExtractCommand(inputFile: string | undefined, options: any) {
  setQuiet(options.quiet);

  let inputText: string;
  if (inputFile) {
    inputText = await Bun.file(inputFile).text();
  } else if (!process.stdin.isTTY) {
    inputText = await Bun.stdin.text();
  } else {
    inputText = await clipboard.read();
  }

  let outputPath = options.output;
  if (options.plan && !options.output) {
    let name = options.plan.endsWith('.yml')
      ? options.plan
      : path.basename(options.plan, '.md') + '.yml';
    outputPath = path.join(path.dirname(options.plan), name);
  }

  // Determine output path
  if (!outputPath) {
    throw new Error('Either --output or --plan must be specified');
  }

  const config = await loadEffectiveConfig(options.config);

  // Check if output file already exists and is a stub plan
  let stubPlanData: PlanSchema | undefined;
  const outputYmlPath = outputPath.endsWith('.yml') ? outputPath : `${outputPath}.yml`;
  try {
    const existingPlan = await readPlanFile(outputYmlPath);
    // Check if it's a stub plan (has structure but no tasks)
    if (existingPlan && (!existingPlan.tasks || existingPlan.tasks.length === 0)) {
      stubPlanData = existingPlan;
      if (!options.quiet) {
        log(chalk.blue('Found existing stub plan, preserving metadata'));
      }
    }
  } catch {
    // File doesn't exist or isn't valid YAML, that's fine
  }

  // Extract markdown to YAML using LLM
  const extractOptions: ExtractMarkdownToYamlOptions = {
    output: outputPath,
    projectId: options.projectId,
    issueUrls: options.issue ? [options.issue] : [],
    stubPlan: stubPlanData ? { data: stubPlanData, path: outputYmlPath } : undefined,
  };

  await extractMarkdownToYaml(inputText, config, options.quiet ?? false, extractOptions);
}
