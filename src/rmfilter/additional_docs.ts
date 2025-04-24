import { $ } from 'bun';
import { glob } from 'fast-glob';
import os from 'node:os';
import path from 'node:path';
import { debugLog } from '../logging.ts';
import { getUsingJj } from './utils.ts';

export async function getAdditionalDocs(
  baseDir: string,
  values: {
    instructions?: string[];
    instruction?: string[];
    docs?: string[];
    rules?: string[];
    'omit-cursorrules'?: boolean;
    'omit-instructions-tag'?: boolean;
  }
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

  let docsTag = '';
  if (values.docs) {
    let docsContent: string[] = [];

    for (let pattern of values.docs) {
      const matches = await glob(pattern);
      if (matches.length === 0) {
        console.error(`No files found matching pattern: ${pattern}`);
        process.exit(1);
      }
      for (const file of matches) {
        try {
          docsContent.push(await Bun.file(file).text());
        } catch (error) {
          console.error(`Error reading docs file: ${file}`);
          process.exit(1);
        }
      }
    }

    let output = docsContent
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n\n');
    docsTag = output ? `<docs>\n${output}\n</docs>` : '';
  }

  let rulesContent: string[] = [];

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
        rulesContent.push(await Bun.file(file).text());
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
      rulesContent.push(cursorrulesContent);
    } catch (error) {
      // It's ok if .cursorrules doesn't exist
    }
  }

  let rulesOutput = rulesContent
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');
  let rulesTag = rulesOutput ? `<rules>\n${rulesOutput}\n</rules>` : '';

  return { docsTag, instructionsTag, rulesTag, rawInstructions };
}

export async function buildExamplesTag(examples: { pattern: string; file: string }[]) {
  if (!examples.length) {
    return '';
  }
  let files = await Promise.all(
    examples.map(async (e) => {
      let content = await Bun.file(e.file).text();
      return `<example>
<pattern>\`${e.pattern}\`</pattern>
<example_file>
${content}
</example_file>
</example>`;
    })
  );

  return `<examples>
This is a list of examples of certain patterns in the codebase which may be helpful to implement those patterns. The pattern tag contains the patterns that was matched to find the file, and should hint as what in the file is relevant.

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
