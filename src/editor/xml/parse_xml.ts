import { parseContentsWithXml } from './parse.ts';
import { applyFileChanges } from './apply.ts';
import type { ProcessFileOptions } from '../types.ts';

export async function processXmlContents({
  content,
  writeRoot,
  dryRun,
  suppressLogging = false,
}: ProcessFileOptions) {
  const changes = (await parseContentsWithXml(content)) ?? [];
  if (!changes) {
    throw new Error(`No changes found in XML output`);
  }

  for (let change of changes) {
    await applyFileChanges(change, writeRoot, dryRun, suppressLogging);
  }
}
