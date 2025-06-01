import { streamText } from 'ai';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';
import { createModel } from '../common/model_factory.js';
import { boldMarkdownHeaders, error, log, warn } from '../logging.js';
import type { RmplanConfig } from './configSchema.js';
import { generatePhaseId, generateProjectId, slugify } from './id_utils.js';
import type { PlanSchema } from './planSchema.js';
import { phaseSchema, planSchema } from './planSchema.js';
import { phaseExampleFormatGeneric, planExampleFormatGeneric } from './prompt.js';
import { fixYaml } from './fix_yaml.js';

// Define the prompt for Markdown to YAML conversion
const markdownToYamlConversionPrompt = `You are an AI assistant specialized in converting structured Markdown text into YAML format. Your task is to convert the provided Markdown input into YAML, strictly adhering to the specified schema.

**Input Markdown:**

Here is the text that needs to be converted to valid YAML:

<input_text>
{markdownInput}
</input_text>

**Instructions:**

1.  **Detect the format:** First, determine if this is a multi-phase plan or a single-phase plan.
    - Multi-phase plans contain sections like "### Phase 1:", "### Phase 2:" etc.
    - Single-phase plans do not have phase sections

2.  **Convert based on format:**

    **For SINGLE-PHASE plans**, use this schema:
    \`\`\`yaml
${planExampleFormatGeneric}
    \`\`\`

    **For MULTI-PHASE plans**, use this schema:
    \`\`\`yaml
${phaseExampleFormatGeneric}
    \`\`\`

3.  **Handle phase dependencies:** For multi-phase plans, convert dependency references like "Phase 1, Phase 2" to phase IDs in format "project-1", "project-2" etc. Use "project" as the default project prefix.

4.  **Handle Markdown lists:** Convert Markdown lists appropriately into YAML sequences.

5.  **Handle Multi-line Strings:** For step prompts, use the YAML pipe character | for multi-line strings.

6.  **Indentation:** Use exactly 2 spaces for YAML indentation levels.

7.  **String quoting:** Use double quotes for YAML strings when necessary, especially for strings containing colons.

8.  **Output Format:** Output *only* the raw, valid YAML string. Do **not** include any introductory text, explanations, comments, or Markdown fences (like \`\`\`yaml or \`\`\`).

**Important for multi-phase plans:**
- Each phase should have an id like "project-1", "project-2" etc.
`;

export async function convertMarkdownToYaml(
  markdownInput: string,
  config: RmplanConfig,
  quiet = false
): Promise<string> {
  const modelSpec = config.models?.convert_yaml || 'google/gemini-2.5-flash-preview-05-20';
  const prompt = markdownToYamlConversionPrompt.replace('{markdownInput}', markdownInput);
  let result = streamText({
    model: createModel(modelSpec),
    prompt,
    temperature: 0,
  });

  if (!quiet) {
    for await (const chunk of result.fullStream) {
      if (chunk.type === 'text-delta') {
        process.stdout.write(chunk.textDelta);
      } else if (chunk.type === 'error') {
        throw new Error((chunk.error as any).toString());
      }
    }
    process.stdout.write('\n');
  }

  return findYamlStart(await result.text);
}

export function findYamlStart(text: string): string {
  // Clean up the output
  text = text.trim();

  // Remove potential Markdown fences
  if (text.startsWith('```yaml') && text.endsWith('```')) {
    text = text.slice(7, -3).trim();
  } else if (text.startsWith('```') && text.endsWith('```')) {
    // Handle generic fences just in case
    text = text.slice(3, -3).trim();
  }

  // Look for the first line that looks like a YAML key
  // A YAML key typically starts with a word character, contains alphanumeric/underscores/hyphens,
  // and ends with a colon (potentially followed by whitespace or a value)
  const lines = text.split('\n');
  let startIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Match a line that looks like a YAML key: starts with a letter, followed by word chars/hyphens, then colon
    if (/^[a-zA-Z][a-zA-Z0-9_-]*:/.test(line)) {
      startIndex = text.indexOf(lines[i]);
      break;
    }
  }

  // Remove potential introductory lines before the actual YAML content
  if (startIndex >= 0) {
    text = text.slice(startIndex);
  }

  return text;
}

export interface ExtractMarkdownToYamlOptions {
  issueUrls?: string[];
  planRmfilterArgs?: string[];
  output: string;
  projectId?: string;
  issueUrl?: string;
}

export async function extractMarkdownToYaml(
  inputText: string,
  config: RmplanConfig,
  quiet: boolean,
  options: ExtractMarkdownToYamlOptions
): Promise<string> {
  let convertedYaml: string;

  try {
    // First try to see if it's YAML already.
    let maybeYaml = findYamlStart(inputText);
    const parsedObject = yaml.parse(maybeYaml);
    convertedYaml = yaml.stringify(parsedObject);
  } catch {
    // Print output if not quiet
    const streamToConsole = !quiet;
    const numLines = inputText.split('\n').length;
    if (!quiet) {
      warn(boldMarkdownHeaders(`\n## Converting ${numLines} lines of Markdown to YAML\n`));
    }
    convertedYaml = await convertMarkdownToYaml(inputText, config, !streamToConsole);
  }

  // Parse the YAML to check if it's multi-phase
  let parsedYaml;
  try {
    parsedYaml = fixYaml(convertedYaml);
  } catch (e) {
    await Bun.write('rmplan-parse-failure.yml', convertedYaml);
    error('Failed to parse YAML. Saved raw output to rmplan-parse-failure.yml');
    throw e;
  }

  // Check if this is a multi-phase plan
  if (parsedYaml.phases && Array.isArray(parsedYaml.phases)) {
    // Multi-phase plan - save as separate files
    return await saveMultiPhaseYaml(parsedYaml, options, config, quiet);
  }

  // Single-phase plan - continue with existing logic
  let validatedPlan: PlanSchema;

  if (!convertedYaml.startsWith('# yaml-language-server')) {
    const schemaLine = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json`;
    convertedYaml = schemaLine + '\n' + convertedYaml;
  }

  // Parse and validate the YAML
  try {
    const result = planSchema.safeParse(parsedYaml);
    if (!result.success) {
      error('Validation errors after LLM conversion:', result.error);
      // Save the failed YAML for debugging
      await Bun.write('rmplan-validation-failure.yml', convertedYaml);
      console.error('Invalid YAML (saved to rmplan-validation-failure.yml):', convertedYaml);
      throw new Error('Validation failed');
    }
    validatedPlan = result.data;

    // Set metadata fields
    validatedPlan.id = options.projectId || generateProjectId();
    const now = new Date().toISOString();
    validatedPlan.createdAt = now;
    validatedPlan.updatedAt = now;
    validatedPlan.planGeneratedAt = now;

    if (validatedPlan.tasks[0]?.steps?.[0]?.prompt) {
      validatedPlan.promptsGeneratedAt = now;
    }

    // Set defaults for status if not already set
    if (!validatedPlan.status) {
      validatedPlan.status = 'pending';
    }
    // Don't set a default priority - let it remain undefined

    // Populate issue and rmfilter arrays from options
    if (options.issueUrls && options.issueUrls.length > 0) {
      validatedPlan.issue = options.issueUrls;
    }
    if (options.planRmfilterArgs && options.planRmfilterArgs.length > 0) {
      validatedPlan.rmfilter = options.planRmfilterArgs;
    }
  } catch (e) {
    // Save the failed YAML for debugging
    await Bun.write('rmplan-conversion-failure.yml', convertedYaml);
    error(
      'Failed to parse YAML output from LLM conversion. Saved raw output to rmplan-conversion-failure.yml'
    );
    error('Parsing error:', e);
    throw e;
  }

  // Create ordered plan with all fields
  const orderedPlan: any = {
    id: validatedPlan.id,
  };

  // Always include status and priority
  if (validatedPlan.status) {
    orderedPlan.status = validatedPlan.status;
  }
  if (validatedPlan.priority) {
    orderedPlan.priority = validatedPlan.priority;
  }

  // Add optional fields only if they have values
  if (validatedPlan.dependencies?.length) {
    orderedPlan.dependencies = validatedPlan.dependencies;
  }
  if (validatedPlan.baseBranch) {
    orderedPlan.baseBranch = validatedPlan.baseBranch;
  }
  if (validatedPlan.rmfilter?.length) {
    orderedPlan.rmfilter = validatedPlan.rmfilter;
  }
  if (validatedPlan.issue?.length) {
    orderedPlan.issue = validatedPlan.issue;
  }
  if (validatedPlan.pullRequest?.length) {
    orderedPlan.pullRequest = validatedPlan.pullRequest;
  }

  // Add required fields
  orderedPlan.goal = validatedPlan.goal;
  orderedPlan.details = validatedPlan.details;
  orderedPlan.planGeneratedAt = validatedPlan.planGeneratedAt;
  orderedPlan.promptsGeneratedAt = validatedPlan.promptsGeneratedAt;
  orderedPlan.createdAt = validatedPlan.createdAt;
  orderedPlan.updatedAt = validatedPlan.updatedAt;
  orderedPlan.tasks = validatedPlan.tasks;

  if (validatedPlan.changedFiles?.length) {
    orderedPlan.changedFiles = validatedPlan.changedFiles;
  }

  const yamlContent = yaml.stringify(orderedPlan);

  // Write single-phase plan to output file
  const outputPath = options.output.endsWith('.yml') ? options.output : `${options.output}.yml`;
  await Bun.write(outputPath, yamlContent);

  if (!quiet) {
    log(`Wrote plan to ${outputPath}`);
  }

  return `Wrote single-phase plan to ${outputPath}`;
}

export async function saveMultiPhaseYaml(
  parsedYaml: any,
  options: ExtractMarkdownToYamlOptions,
  config: RmplanConfig,
  quiet: boolean
): Promise<string> {
  // Determine project ID
  let issueUrl: string | undefined;

  const projectId = options.projectId || generateProjectId();

  if (!quiet) {
    log(chalk.blue('Using Project ID:'), projectId);
  }

  // Check if there's actually just one phase. In this case we still do the multi-phase
  // code since it will bring in the goal and details from both the global and phase,
  // but we end up saving to a single file instead of a subdirectory.
  const actuallyMultiphase = parsedYaml.phases.length > 1;
  const outputDir = options.output;

  // Extract overall project information from the parsed YAML
  const projectInfo = {
    goal: parsedYaml.goal || '',
    title: parsedYaml.title || '',
    details: parsedYaml.details || '',
  };

  // Process phases
  const phaseIndexToId = new Map<number, string>();
  let successfulWrites = 0;
  const failedPhases: number[] = [];

  // First pass: generate IDs and update dependencies
  for (let i = 0; i < parsedYaml.phases.length; i++) {
    const phase = parsedYaml.phases[i];
    const phaseId = generatePhaseId(projectId, i + 1);
    phaseIndexToId.set(i + 1, phaseId);
    phase.id = phaseId;

    // Add metadata if not present
    const now = new Date().toISOString();
    phase.planGeneratedAt = phase.planGeneratedAt || now;
    phase.createdAt = phase.createdAt || now;
    phase.updatedAt = phase.updatedAt || now;

    // Add overall project information to each phase
    if (projectInfo.goal || projectInfo.title || projectInfo.details) {
      phase.project = projectInfo;
    }

    // Add rmfilter and issue from options
    if (options.planRmfilterArgs?.length) {
      phase.rmfilter = options.planRmfilterArgs;
    }
    if (issueUrl) {
      phase.issue = [issueUrl];
    }

    // Update dependencies to use phase IDs
    if (phase.dependencies && Array.isArray(phase.dependencies)) {
      phase.dependencies = phase.dependencies.map((dep: string) => {
        // Convert from "project-N" or similar to actual phase ID
        let match = dep.match(/-(\d+)$/) || dep.match(/Phase (\d+)$/) || dep.match(/(\d+)/);

        if (match) {
          const depIndex = parseInt(match[1], 10);
          return phaseIndexToId.get(depIndex) || dep;
        }
        return dep;
      });
    }
  }

  // Second pass: remove redundant dependencies
  // Build a map of all dependencies for each phase
  const phaseDependencies = new Map<string, Set<string>>();

  for (const phase of parsedYaml.phases) {
    if (phase.dependencies && Array.isArray(phase.dependencies)) {
      phaseDependencies.set(phase.id, new Set(phase.dependencies));
    } else {
      phaseDependencies.set(phase.id, new Set());
    }
  }

  // For each phase, compute all transitive dependencies
  function getTransitiveDependencies(phaseId: string, visited = new Set<string>()): Set<string> {
    if (visited.has(phaseId)) {
      return new Set();
    }
    visited.add(phaseId);

    const directDeps = phaseDependencies.get(phaseId) || new Set();
    const allDeps = new Set(directDeps);

    for (const dep of directDeps) {
      const transitiveDeps = getTransitiveDependencies(dep, visited);
      for (const transDep of transitiveDeps) {
        allDeps.add(transDep);
      }
    }

    return allDeps;
  }

  // Remove redundant dependencies
  for (const phase of parsedYaml.phases) {
    if (!phase.dependencies || phase.dependencies.length === 0) {
      continue;
    }

    const originalDeps = new Set<string>(phase.dependencies);
    const necessaryDeps = new Set<string>();

    // For each dependency, check if it's transitively included by another dependency
    for (const dep of originalDeps) {
      let isRedundant = false;

      for (const otherDep of originalDeps) {
        if (dep === otherDep) continue;

        const transitiveDeps = getTransitiveDependencies(otherDep);
        if (transitiveDeps.has(dep)) {
          isRedundant = true;
          break;
        }
      }

      if (!isRedundant) {
        necessaryDeps.add(dep);
      }
    }

    // Update the phase dependencies
    phase.dependencies = Array.from(necessaryDeps).sort();
  }

  // Write phase YAML files
  for (let i = 0; i < parsedYaml.phases.length; i++) {
    const phase = parsedYaml.phases[i];
    const phaseIndex = i + 1;

    // Validate phase
    const validationResult = phaseSchema.safeParse(phase);
    if (!validationResult.success) {
      warn(`Warning: Phase ${phaseIndex} failed validation:`, validationResult.error.issues);
      failedPhases.push(phaseIndex);
      continue;
    }

    const orderedContent = Object.fromEntries(
      Object.keys(planSchema.shape).map((key) => {
        const value = validationResult.data[key as keyof PlanSchema];
        return [key, value];
      })
    );

    const yamlContent = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n${yaml.stringify(orderedContent)}`;
    const phaseFilePath = actuallyMultiphase
      ? path.join(outputDir, `phase-${phaseIndex}.yml`)
      : `${options.output}.yml`;

    try {
      await Bun.write(phaseFilePath, yamlContent);
      successfulWrites++;
    } catch (err) {
      warn(`Warning: Failed to write phase ${phaseIndex} YAML file:`, err);
      failedPhases.push(phaseIndex);
    }
  }

  if (successfulWrites === 0) {
    throw new Error('Failed to write any phase YAML files');
  }

  if (!quiet) {
    if (actuallyMultiphase) {
      log(chalk.green(`✓ Successfully converted markdown to ${successfulWrites} phase files`));
      log(`Output directory: ${outputDir}`);
    } else {
      log(chalk.green(`✓ Successfully converted markdown to 1 phase file`));
      log(`Output file: ${options.output}.yml`);
    }
  }

  if (failedPhases.length > 0) {
    warn(`Warning: Failed to write ${failedPhases.length} phase files: ${failedPhases.join(', ')}`);
  }

  return `Wrote ${successfulWrites} phase files to directory ${outputDir}`;
}
