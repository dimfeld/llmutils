// Command handler for 'rmplan add-implementation-note'
// Adds implementation notes to a plan's details section under "# Implementation Notes"

import { readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';

/**
 * Appends implementation notes to the plan's details field.
 * Creates an "# Implementation Notes" section if it doesn't exist.
 *
 * @param planFile - Plan file path or plan ID
 * @param note - The implementation note text to append
 * @param command - Commander.js command object
 */
export async function handleAddImplementationNoteCommand(
  planFile: string,
  note: string,
  command: any
) {
  if (!planFile || typeof planFile !== 'string') {
    throw new Error('You must specify a plan file path or plan ID');
  }
  if (!note || typeof note !== 'string' || note.trim().length === 0) {
    throw new Error('You must provide a non-empty implementation note');
  }

  const globalOpts = command.parent.opts();
  await loadEffectiveConfig(globalOpts.config);

  // Resolve file or ID to an absolute plan file path
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);

  // Read the current plan
  const plan = await readPlanFile(resolvedPlanFile);

  // Get existing details or empty string
  let details = plan.details || '';

  // Check if Implementation Notes section exists
  const sectionHeader = '# Implementation Notes';
  const trimmedNote = note.trim();

  if (details.includes(sectionHeader)) {
    // Section exists, append the note
    details = `${details.trimEnd()}\n\n${trimmedNote}`;
  } else {
    // Section doesn't exist, create it at the bottom
    const separator = details.trim() ? '\n\n' : '';
    details = `${details.trimEnd()}${separator}${sectionHeader}\n\n${trimmedNote}`;
  }

  // Update the plan with modified details
  plan.details = details;
  await writePlanFile(resolvedPlanFile, plan);

  log(`Added implementation note to ${resolvedPlanFile}`);
}
