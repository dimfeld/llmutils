import { parseXmlString } from './xml/parse.ts';
import { applyFileChanges } from './xml/apply.ts';

export async function processXmlContents({
  content,
  writeRoot,
}: {
  content: string;
  writeRoot: string;
}) {
  const changes = (await parseXmlString(content)) ?? [];
  if (!changes) {
    throw new Error(`No changes found in XML output`);
  }

  for (let change of changes) {
    await applyFileChanges(change, writeRoot);
  }
}
