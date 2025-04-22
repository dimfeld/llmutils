import { $ } from 'bun';
import { processRawFiles } from '../editor/whole-file/parse_raw_edits.ts';
import { processXmlContents } from '../editor/xml/parse_xml.ts';
import { processSearchReplace } from '../editor/diff-editor/parse.ts';
import { processUnifiedDiff } from '../editor/udiff-simple/parse.ts';

export interface ApplyLlmEditsOptions {
  content: string;
  writeRoot?: string;
  dryRun?: boolean;
}

export async function applyLlmEdits({ content, writeRoot, dryRun }: ApplyLlmEditsOptions) {
  writeRoot ??= await getWriteRoot();
  const xmlMode = content.includes('<code_changes>');
  const diffMode = content.includes('<<<<<<< SEARCH');
  const udiffMode = content.includes('```diff') && content.includes('@@');

  if (udiffMode) {
    return await processUnifiedDiff({
      content,
      writeRoot,
      dryRun,
    });
  } else if (diffMode) {
    return await processSearchReplace({
      content,
      writeRoot,
      dryRun,
    });
  } else if (xmlMode) {
    return await processXmlContents({
      content,
      writeRoot,
      dryRun,
    });
  } else {
    return await processRawFiles({
      content,
      writeRoot,
      dryRun,
    });
  }
}

export async function getWriteRoot(cwd?: string) {
  return cwd || (await $`git rev-parse --show-toplevel`.text()).trim() || process.cwd();
}
