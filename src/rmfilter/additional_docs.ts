import { glob } from 'fast-glob';
import os from 'node:os';
import path from 'node:path';

export async function getAdditionalDocs(
  baseDir: string,
  values: {
    instructions?: string[];
    instruction?: string[];
    docs?: string[];
    rules?: string[];
    'omit-cursorrules'?: boolean;
  }
) {
  let instructionsTag = '';
  let instructionValues = [...(values.instructions || []), ...(values.instruction || [])];
  if (instructionValues.length) {
    let instructionsContent: string[] = [];

    for (let instruction of instructionValues) {
      if (instruction.startsWith('@')) {
        const pattern = instruction.slice(1);
        const matches = await glob(pattern);
        if (matches.length === 0) {
          console.error(`No files found matching pattern: ${pattern}`);
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

    let output = instructionsContent.map((s) => s.trim()).join('\n\n');
    instructionsTag = `<instructions>\n${output}\n</instructions>`;
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

    let output = docsContent.map((s) => s.trim()).join('\n\n');
    docsTag = `<docs>\n${output}\n</docs>`;
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

  let rulesOutput = rulesContent.map((s) => s.trim()).join('\n\n');
  let rulesTag = rulesOutput ? `<rules>\n${rulesOutput}\n</rules>` : '';

  return { docsTag, instructionsTag, rulesTag };
}
