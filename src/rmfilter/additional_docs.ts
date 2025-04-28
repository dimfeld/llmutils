import { $ } from 'bun';
import { glob } from 'fast-glob';
import os from 'node:os';
import path from 'node:path';
import { debugLog } from '../logging.ts';
import type { MdcFile } from './mdc.ts'; // [1] Import MdcFile type
import { getUsingJj } from './utils.ts';

// Helper function to escape XML attribute values (specifically quotes)
function escapeXmlAttr(value: string): string {
  return value.replace(/"/g, '&quot;');
}


export async function getAdditionalDocs(
  baseDir: string,
  values: {
    instructions?: string[];
    instruction?: string[];
    docs?: string[];
    rules?: string[];
    'omit-cursorrules'?: boolean;
    'omit-instructions-tag'?: boolean;
  },
  filteredMdcFiles: MdcFile[] = [] // [2] Add filteredMdcFiles parameter
) {
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
          console.error(`No files found matching instructions pattern: ${pattern}`);
          process.exit(1);
        }
        for (const file of matches) {
          try {
            instructionsContent.push(await Bun.file(file).text());
          } catch (error) {
            console.error(`Error reading instructions file: ${file}`);
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

  // [3] Refactor Docs Processing
  let docsOutputTag = ''; // Rename docsTag
  const manualDocsContent: string[] = []; // Rename docsContent

  if (values.docs) {
    for (const pattern of values.docs) {
      const matches = await glob(pattern);
      if (matches.length === 0) {
        console.error(`No files found matching pattern: ${pattern}`);
        process.exit(1);
      }
      for (const file of matches) {
        try {
          manualDocsContent.push(await Bun.file(file).text());
        } catch (error) {
          console.error(`Error reading docs file: ${file}`);
          process.exit(1);
        }
      }
    }

    // Old logic for simple docs tag is removed here, handled below with MDC files.
  }

  // Initialize combined documents data
  const allDocumentsData: { content: string; description?: string }[] = [];

  // Populate from manually specified --docs files
  manualDocsContent.forEach(content => {
    if (content.trim()) {
      allDocumentsData.push({ content: content.trim() });
    }
  });

  // Populate from filtered MDC files (type 'docs' or default)
  for (const mdcFile of filteredMdcFiles) {
    const type = mdcFile.data.type?.toLowerCase();
    if (type === 'docs' || type === undefined || type === null || type === '') {
      if (mdcFile.content.trim()) {
        allDocumentsData.push({ content: mdcFile.content.trim(), description: mdcFile.data.description });
      }
    }
  }

  // Generate the final <documents> tag
  if (allDocumentsData.length > 0) {
    const documentTags = allDocumentsData.map(doc => {
      const descAttr = doc.description ? ` description="${escapeXmlAttr(doc.description)}"` : '';
      return `<document${descAttr}><![CDATA[\n${doc.content}\n]]></document>`;
    }).join('\n');
    docsOutputTag = `<documents>\n${documentTags}\n</documents>`;
  }

  // [4] Refactor Rules Processing
  const manualRulesContent: string[] = []; // Rename rulesContent
  for (let pattern of values.rules || []) {
    // simple check, should be better
    if (pattern.startsWith('~/')) {
      let homeDir = os.homedir();
      pattern = path.join(homeDir, pattern.slice(2));
    }

    const matches = await glob(pattern);
    if (matches.length === 0) {
      console.error(`No files found matching pattern: ${pattern}`);
      process.exit(1);
    }
    for (const file of matches) {
      try {
        manualRulesContent.push(await Bun.file(file).text());
      } catch (error) {
        console.error(`Error reading rules file: ${file}`);
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
  manualRulesContent.forEach(content => {
    if (content.trim()) {
      allRulesData.push({ content: content.trim() });
    }
  });

  // Populate from filtered MDC files (type 'rules')
  for (const mdcFile of filteredMdcFiles) {
    const type = mdcFile.data.type?.toLowerCase();
    if (type === 'rules') {
       if (mdcFile.content.trim()) {
        allRulesData.push({ content: mdcFile.content.trim(), description: mdcFile.data.description });
      }
    }
  }

  // Generate the final <rules> tag
  let rulesOutputTag = ''; // Rename rulesTag
  if (allRulesData.length > 0) {
    const ruleTags = allRulesData.map(rule => {
      const descAttr = rule.description ? ` description="${escapeXmlAttr(rule.description)}"` : '';
      return `<rule${descAttr}><![CDATA[\n${rule.content}\n]]></rule>`;
    }).join('\n');
    rulesOutputTag = `<rules>\n${ruleTags}\n</rules>`;
  }

  // [5] Update return statement
  return { docsTag: docsOutputTag, instructionsTag, rulesTag: rulesOutputTag, rawInstructions };
}

export async function buildExamplesTag(examples: { pattern: string; file: string }[]) {
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

      let content = await Bun.file(file).text();
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

export async function getDiffTag(
  baseDir: string,
  values: { 'with-diff'?: boolean; 'diff-from'?: string; 'changed-files'?: boolean }
) {
  let baseBranch: string | undefined;
  if (values['diff-from']) {
    baseBranch = values['diff-from'];
  } else if (values['with-diff'] || values['changed-files']) {
    // Try to get default branch from git config
    baseBranch = (
      await $`git config --get init.defaultBranch`.cwd(baseDir).nothrow().text()
    ).trim();

    if (!baseBranch) {
      // Try to get default branch from remote
      const defaultBranch = (await $`git branch --list main master`.cwd(baseDir).nothrow().text())
        .replace('*', '')
        .trim();

      baseBranch = defaultBranch || 'main';
    }
  }

  if (!baseBranch) {
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

    const from = `latest(ancestors(${baseBranch})&ancestors(@))`;

    if (values['with-diff']) {
      diff = await $`jj diff --from ${from} ${exclude}`.cwd(baseDir).nothrow().text();
    }

    if (values['changed-files']) {
      let summ = await $`jj diff --from ${from} --summary ${exclude}`.cwd(baseDir).nothrow().text();
      changedFiles = summ
        .split('\n')
        .map((line) => {
          line = line.trim();
          if (!line || line.startsWith('D')) {
            return '';
          }

          // M file/name
          return line.slice(2);
        })
        .filter((line) => !!line);
    }
  } else {
    const exclude = excludeFiles.map((f) => `:(exclude)${f}`);
    if (values['with-diff']) {
      diff = await $`git diff ${baseBranch} ${exclude}`.cwd(baseDir).nothrow().text();
    }

    if (values['changed-files']) {
      let summ = await $`git diff --name-only ${baseBranch} ${exclude}`
        .cwd(baseDir)
        .nothrow()
        .text();
      changedFiles = summ
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !!line);
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
