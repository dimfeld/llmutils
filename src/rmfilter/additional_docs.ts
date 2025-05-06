import { $ } from 'bun';
import { glob } from 'fast-glob';
import os from 'node:os';
import path from 'node:path';
import { debugLog, error } from '../logging.ts';
import { filterMdcFiles, findMdcFiles, parseMdcFile, type MdcFile } from './mdc.ts';
import { getGitRoot, getUsingJj } from './utils.ts';

// Helper function to escape XML attribute values (specifically quotes)
function escapeXmlAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}

export interface AdditionalDocsOptions {
  instructions?: string[];
  instruction?: string[];
  docs?: string[];
  rules?: string[];
  'omit-cursorrules'?: boolean;
  'omit-instructions-tag'?: boolean;
  'no-autodocs'?: boolean;
}

export async function getAdditionalDocs(
  baseDir: string,
  allFilesSet: Set<string>,
  values: AdditionalDocsOptions
) {
  const gitRoot = await getGitRoot();

  // MDC processing
  let filteredMdcFiles: MdcFile[] = [];
  if (!values['no-autodocs']) {
    try {
      debugLog('[MDC] Starting MDC processing...');
      const mdcFilePaths = await findMdcFiles(gitRoot);
      if (mdcFilePaths.length > 0) {
        const parsedMdcFilesResults = await Promise.all(
          mdcFilePaths.map((filePath) => parseMdcFile(filePath))
        );
        // Filter out null results from parsing errors
        const parsedMdcFiles = parsedMdcFilesResults.filter(
          (result): result is MdcFile => result !== null
        );
        debugLog(`[MDC] Parsed ${parsedMdcFiles.length} MDC files successfully.`);

        if (parsedMdcFiles.length > 0) {
          // Convert relative source paths in allFilesSet to absolute paths
          const absoluteSourceFiles = Array.from(allFilesSet, (p) => path.resolve(gitRoot, p));
          debugLog(`[MDC] Filtering against ${absoluteSourceFiles.length} active source files.`);

          filteredMdcFiles = await filterMdcFiles(parsedMdcFiles, absoluteSourceFiles, gitRoot);
          debugLog(`[MDC] Filtered MDC files included: ${filteredMdcFiles.length}`);
        }
      } else {
        debugLog('[MDC] No MDC files found.');
      }
    } catch (err: any) {
      error(`[MDC] Error during MDC processing: ${err.message}`);
      // Log and continue, filteredMdcFiles might be empty or partially filled
      debugLog(`[MDC] Processing error details: ${err.stack}`);
    }
  } else {
    debugLog('[MDC] MDC processing disabled via --no-autodocs flag.');
  }

  return gatherDocsInternal(baseDir, values, filteredMdcFiles);
}

export async function gatherDocsInternal(
  baseDir: string,
  values: {
    instructions?: string[];
    instruction?: string[];
    docs?: string[];
    rules?: string[];
    'omit-cursorrules'?: boolean;
    'omit-instructions-tag'?: boolean;
    'no-autodocs'?: boolean;
  },
  filteredMdcFiles: MdcFile[] = []
) {
  const gitRoot = await getGitRoot();
  let instructionsTag = '';
  let rawInstructions = '';
  let instructionValues = [...(values.instructions || []), ...(values.instruction || [])];
  if (instructionValues.length) {
    let instructionsContent: string[] = [];

    for (let instruction of instructionValues) {
      if (instruction.startsWith('@')) {
        const pattern = instruction.slice(1);
        const matches = await glob(pattern);
        if (matches.length === 0) {
          error(`No files found matching instructions pattern: ${pattern}`);
          process.exit(1);
        }
        for (const file of matches) {
          try {
            instructionsContent.push(await Bun.file(file).text());
          } catch (e) {
            error(`Error reading instructions file: ${file}`);
            process.exit(1);
          }
        }
      } else {
        instructionsContent.push(instruction);
      }
    }

    rawInstructions = instructionsContent
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (rawInstructions) {
      if (values['omit-instructions-tag']) {
        instructionsTag = rawInstructions;
      } else {
        instructionsTag = `<instructions>\n${rawInstructions}\n</instructions>`;
      }
    }
  }

  let docsOutputTag = '';
  const manualDocsContent: string[] = [];
  const docFilesPaths: string[] = [];
  const ruleFilesPaths: string[] = [];

  if (values.docs) {
    for (const pattern of values.docs) {
      const matches = await glob(pattern);
      if (matches.length === 0) {
        error(`No files found matching pattern: ${pattern}`);
        process.exit(1);
      }
      for (const file of matches) {
        try {
          manualDocsContent.push(await Bun.file(file).text());
          docFilesPaths.push(path.relative(gitRoot, file));
        } catch (e) {
          error(`Error reading docs file: ${file}`);
          process.exit(1);
        }
      }
    }
  }

  // Initialize combined documents data
  const allDocumentsData: { content: string; description?: string }[] = [];

  // Populate from manually specified --docs files
  manualDocsContent.forEach((content) => {
    if (content.trim()) {
      allDocumentsData.push({ content: content.trim() });
    }
  });

  function isDoc(file: MdcFile) {
    const type = file.data.type?.toLowerCase();
    return type === 'docs' || type === 'doc' || type === 'document';
  }

  const docFiles: MdcFile[] = [];
  const ruleFiles: MdcFile[] = [];

  for (const mdcFile of filteredMdcFiles) {
    const relativePath = path.relative(gitRoot, mdcFile.filePath);
    if (isDoc(mdcFile)) {
      docFiles.push(mdcFile);
      docFilesPaths.push(relativePath);
    } else {
      ruleFiles.push(mdcFile);
      ruleFilesPaths.push(relativePath);
    }
  }

  // Populate from filtered MDC files (type 'docs' or default)
  for (const mdcFile of docFiles) {
    if (mdcFile.content.trim()) {
      allDocumentsData.push({
        content: mdcFile.content.trim(),
        description: mdcFile.data.description,
      });
    }
  }

  // Generate the final <documents> tag
  if (allDocumentsData.length > 0) {
    const documentTags = allDocumentsData
      .map((doc) => {
        const descAttr = doc.description ? ` description="${escapeXmlAttr(doc.description)}"` : '';
        return `<document${descAttr}><![CDATA[\n${doc.content}\n]]></document>`;
      })
      .join('\n');
    docsOutputTag = `<documents>\n${documentTags}\n</documents>`;
  }

  // [4] Refactor Rules Processing
  const manualRulesContent: string[] = [];
  for (let pattern of values.rules || []) {
    // simple check, should be better
    if (pattern.startsWith('~/')) {
      let homeDir = os.homedir();
      pattern = path.join(homeDir, pattern.slice(2));
    }

    const matches = await glob(pattern);
    if (matches.length === 0) {
      error(`No files found matching pattern: ${pattern}`);
      process.exit(1);
    }
    for (const file of matches) {
      try {
        manualRulesContent.push(await Bun.file(file).text());
      } catch (e) {
        error(`Error reading rules file: ${file}`);
        process.exit(1);
      }
    }
  }

  if (!values['omit-cursorrules']) {
    const cursorrulesPath = path.join(baseDir, '.cursorrules');
    try {
      const cursorrulesContent = await Bun.file(cursorrulesPath).text();
      manualRulesContent.push(cursorrulesContent);
    } catch (error) {
      // It's ok if .cursorrules doesn't exist
    }
  }

  // Initialize combined rules data
  const allRulesData: { content: string; description?: string }[] = [];

  // Populate from manually specified --rules files and .cursorrules
  manualRulesContent.forEach((content) => {
    if (content.trim()) {
      allRulesData.push({ content: content.trim() });
    }
  });

  // Populate from filtered MDC files (type 'rules')
  for (const mdcFile of ruleFiles) {
    if (mdcFile.content.trim()) {
      allRulesData.push({
        content: mdcFile.content.trim(),
        description: mdcFile.data.description,
      });
    }
  }

  // Generate the final <rules> tag
  let rulesOutputTag = '';
  if (allRulesData.length > 0) {
    const ruleTags = allRulesData
      .map((rule) => {
        const descAttr = rule.description
          ? ` description="${escapeXmlAttr(rule.description)}"`
          : '';
        return `<rule${descAttr}><![CDATA[\n${rule.content}\n]]></rule>`;
      })
      .join('\n');
    rulesOutputTag = `<rules>\n${ruleTags}\n</rules>`;
  }

  return {
    docsTag: docsOutputTag,
    instructionsTag,
    rulesTag: rulesOutputTag,
    rawInstructions,
    docFilesPaths,
    ruleFilesPaths,
  };
}

export async function buildExamplesTag(
  gitRoot: string,
  examples: { pattern: string; file: string }[]
) {
  if (!examples.length) {
    return '';
  }

  let grouped = Object.groupBy(examples, (e) => e.file);

  let files = await Promise.all(
    Object.values(grouped).map(async (e) => {
      let file = e![0].file;
      let patterns = e!.map(({ pattern }) => {
        // Component examples commonly start with < since it improves grep accuracy, but remove
        // that here to make it more clear to the model.
        if (pattern.startsWith('<') && !pattern.endsWith('>')) {
          pattern = pattern.slice(1);
        }
        return `for="${pattern}"`;
      });

      let content = await Bun.file(path.resolve(gitRoot, file)).text();
      // This isn't really valid XML but the LLM doesn't care.
      let patternAttr = patterns.join(' ');

      return `
<example ${patternAttr}>
${content}
</example>`;
    })
  );

  return `<examples>
# Code Examples Reference
This section contains real code examples from the codebase that demonstrate key patterns and components. When writing code, reference these examples to maintain consistent style and implementation patterns.

## How to use these examples:
1. Each example is tagged with one or more pattern identifiers in the \`for\` attribute
2. Study the implementation details for the relevant portion of the file before coding similar functionality
3. Match variable naming conventions, parameter usage, and overall structure

${files.join('\n')}
</examples>`;
}

/**
 * Parses a jj diff rename line and returns the "after" path.
 * Example input: R apps/inbox/src/{routes/inventory/inventories/[inventoryId] => lib/components/ui/inventory}/InventoryPicker.svelte
 * Output: apps/inbox/src/lib/components/ui/inventory/InventoryPicker.svelte
 */
export function parseJjRename(line: string): string {
  const match = line.match(/^R\s+(.+?)\{(.+?)\s*=>\s*(.*?)\}(.+)$/);
  if (!match) {
    debugLog(`[parseJjRename] Invalid rename format: ${line}`);
    return '';
  }
  const [, prefix, , after, suffix] = match;
  return `${prefix}${after || ''}${suffix}`;
}

export const CURRENT_DIFF = `HEAD~`;

async function getTrunkBranch(gitRoot: string): Promise<string> {
  const defaultBranch = (await $`git branch --list main master`.cwd(gitRoot).nothrow().text())
    .replace('*', '')
    .trim();
  return defaultBranch || 'main';
}

/**
 * Gets the list of changed files compared to a base branch
 */
export async function getChangedFiles(gitRoot: string, baseBranch?: string): Promise<string[]> {
  if (!baseBranch) {
    // Try to get default branch from git config
    baseBranch = (
      await $`git config --get init.defaultBranch`.cwd(gitRoot).nothrow().text()
    ).trim();

    if (!baseBranch) {
      baseBranch = await getTrunkBranch(gitRoot);
    }
  }

  if (!baseBranch) {
    debugLog('[ChangedFiles] Could not determine base branch.');
    return [];
  }

  const excludeFiles = [
    'pnpm-lock.yaml',
    'bun.lockb',
    'package-lock.json',
    'bun.lock',
    'yarn.lock',
    'Cargo.lock',
  ];

  let changedFiles: string[] = [];
  if (await getUsingJj()) {
    if (baseBranch === CURRENT_DIFF) {
      // convert from
      baseBranch = '@-';
    }

    const exclude = [...excludeFiles.map((f) => `~file:${f}`), '~glob:**/*_snapshot.json'].join(
      '&'
    );
    const from = `latest(ancestors(${baseBranch})&ancestors(@))`;
    let summ = await $`jj diff --from ${from} --summary ${exclude}`.cwd(gitRoot).nothrow().text();
    changedFiles = summ
      .split('\n')
      .map((line) => {
        line = line.trim();
        if (!line || line.startsWith('D')) {
          return '';
        }
        if (line.startsWith('R')) {
          return parseJjRename(line);
        }
        return line.slice(2);
      })
      .filter((line) => !!line);
  } else {
    const exclude = excludeFiles.map((f) => `:(exclude)${f}`);
    let summ = await $`git diff --name-only ${baseBranch} ${exclude}`.cwd(gitRoot).nothrow().text();
    changedFiles = summ
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !!line);
  }

  return changedFiles;
}

export async function getDiffTag(
  gitRoot: string,
  values: { 'with-diff'?: boolean; 'diff-from'?: string; 'changed-files'?: boolean }
) {
  let baseBranch: string | undefined = values['diff-from'] || (await getTrunkBranch(gitRoot));

  // If neither diff nor changed-files requested, no need to proceed further.
  if (!values['with-diff'] && !values['changed-files']) {
    debugLog('[Diff] Neither --with-diff nor --changed-files specified.');
    return { diffTag: '', changedFiles: [] };
  }

  const excludeFiles = [
    'pnpm-lock.yaml',
    'bun.lockb',
    'package-lock.json',
    'bun.lock',
    'yarn.lock',
    'Cargo.lock',
  ];

  let diff = '';
  let changedFiles: string[] = [];
  if (await getUsingJj()) {
    const exclude = [...excludeFiles.map((f) => `~file:${f}`), '~glob:**/*_snapshot.json'].join(
      '&'
    );

    // Base branch must exist at this point if we need it
    const from = `latest(ancestors(${baseBranch})&ancestors(@))`;

    if (values['with-diff']) {
      diff = await $`jj diff --from ${from} ${exclude}`.cwd(gitRoot).nothrow().text();
    }

    if (values['changed-files']) {
      changedFiles = await getChangedFiles(gitRoot, baseBranch);
    }
  } else {
    const exclude = excludeFiles.map((f) => `:(exclude)${f}`);
    // Base branch must exist at this point if we need it
    if (values['with-diff'] && baseBranch) {
      diff = await $`git diff ${baseBranch} ${exclude}`.cwd(gitRoot).nothrow().text();
    }

    if (values['changed-files'] && baseBranch) {
      changedFiles = await getChangedFiles(gitRoot, baseBranch);
    }
  }

  let diffTag = diff
    ? `<git_diff>
This is a diff of all the current changes in this branch from the base branch.

${diff}
</git_diff>`
    : '';

  return {
    diffTag,
    changedFiles,
  };
}
