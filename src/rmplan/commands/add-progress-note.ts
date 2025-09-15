// Command handler for 'rmplan add-progress-note'
// Adds a timestamped progress note to a plan's progressNotes array

import { loadEffectiveConfig } from '../configLoader.js';
import { readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import { log } from '../../logging.js';

export async function handleAddProgressNoteCommand(planFile: string, note: string, command: any) {
  if (!planFile || typeof planFile !== 'string') {
    throw new Error('You must specify a plan file path or plan ID');
  }
  if (!note || typeof note !== 'string' || note.trim().length === 0) {
    throw new Error('You must provide a non-empty progress note');
  }

  const globalOpts = command.parent.opts();
  await loadEffectiveConfig(globalOpts.config); // Ensure config loads for consistency; not used directly here

  // Resolve file or ID to an absolute plan file path
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);

  // Load, mutate, save
  const plan = await readPlanFile(resolvedPlanFile);

  const timestamp = new Date().toISOString();
  const entry = { timestamp, text: note };
  if (!Array.isArray(plan.progressNotes)) {
    plan.progressNotes = [];
  }
  plan.progressNotes.push(entry);

  await writePlanFile(resolvedPlanFile, plan);

  log(`Added progress note to ${resolvedPlanFile}`);
}
