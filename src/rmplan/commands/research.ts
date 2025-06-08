import { handleResearch } from '../actions.js';
import { resolvePlanFile } from '../plans.js';

/**
 * Handles the rmplan research command.
 * Generates research prompts for plan investigations and copies them to the clipboard.
 *
 * @param planArg - Plan file path or ID
 * @param options - Command options including --rmfilter flag
 * @param command - Commander command instance
 */
export async function handleResearchCommand(
  planArg: string,
  options: { rmfilter?: boolean },
  command: any
): Promise<void> {
  // Get global options from parent command
  const globalOptions = command.parent.opts();

  // Resolve the plan file path
  const planFile = await resolvePlanFile(planArg, globalOptions.config);

  // Extract additional arguments passed after a `--` separator
  const argv = process.argv;
  const separatorIndex = argv.indexOf('--');
  const rmfilterArgs = separatorIndex !== -1 ? argv.slice(separatorIndex + 1) : [];

  // Call the core action function
  await handleResearch(planFile, {
    rmfilter: options.rmfilter,
    rmfilterArgs,
  });
}
