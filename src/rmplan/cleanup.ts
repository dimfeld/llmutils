import { generateText, streamText } from 'ai';
import { createModel } from '../common/model_factory.js';
import { planExampleFormatGeneric } from './prompt.js';
import { getChangedFiles } from '../rmfilter/additional_docs.ts';
import { getGitRoot } from '../rmfilter/utils.ts';
import { debugLog, error, log } from '../logging.ts';
import path from 'node:path';

// Define the prompt for Markdown to YAML conversion
const markdownToYamlConversionPrompt = `You are an AI assistant specialized in converting structured Markdown text into YAML format. Your task is to convert the provided Markdown input into YAML, strictly adhering to the specified schema.

**Input Markdown:**

Here is the text that needs to be converted to valid YAML:

<input_text>
{markdownInput}
</input_text>

**Instructions:**

1.  **Convert the Markdown input into YAML format.**
2.  **Strictly adhere to the following YAML schema:**
    \`\`\`yaml
${planExampleFormatGeneric}
    \`\`\`
3.  **Handle Markdown lists:** Convert Markdown lists under 'Files:' and numbered lists under 'Steps:' into YAML sequences.
4.  **Handle Multi-line Strings:** For step prompts, use the YAML pipe character | instead of the > character for multi-line strings.
5.  **Indentation:** Use exactly 2 spaces for YAML indentation levels.
6.  **String quoting:** Use double quotes for YAML strings when necessary. Commonly you will see single-line strings with a colon ":", especially in task titles. These need to be quoted.
7.  **Output Format:** Output *only* the raw, valid YAML string. Do **not** include any introductory text, explanations, comments, or Markdown fences (like \`\`\`yaml or \`\`\`).

**Example Input (Markdown):**
See the structure in the provided Markdown input text.
**Required Output (YAML):**
A single block of valid YAML text conforming to the schema.`;

export async function convertMarkdownToYaml(markdownInput: string, quiet = false): Promise<string> {
  const prompt = markdownToYamlConversionPrompt.replace('{markdownInput}', markdownInput);
  let result = streamText({
    model: createModel('google/gemini-2.5-flash-preview-04-17'),
    prompt,
    temperature: 0,
  });

  if (!quiet) {
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
    }
    process.stdout.write('\n');
  }

  return findYamlStart(await result.text);
}

export function findYamlStart(text: string): string {
  // Clean up the output
  text = text.trim();

  // Remove potential Markdown fences
  if (text.startsWith('```yaml') && text.endsWith('```')) {
    text = text.slice(7, -3).trim();
  } else if (text.startsWith('```') && text.endsWith('```')) {
    // Handle generic fences just in case
    text = text.slice(3, -3).trim();
  }

  // Remove potential introductory lines before the actual YAML content
  const startIndex = text.indexOf('goal:');
  if (startIndex >= 0) {
    text = text.slice(startIndex);
  }

  return text;
}

/**
 * Removes end-of-line comments from supported file types
 * @param baseBranch Optional base branch for diff comparison when no files are provided
 * @param files Optional list of specific files to clean
 */
export async function cleanupEolComments(baseBranch?: string, files?: string[]): Promise<void> {
  const gitRoot = await getGitRoot();
  if (!gitRoot) {
    error('Could not determine Git repository root');
    return;
  }

  let targetFiles: string[];
  if (files && files.length > 0) {
    // Use provided files, ensuring they're resolved relative to git root
    targetFiles = files.map((file) => path.resolve(gitRoot, file));
    // Verify files exist
    targetFiles = (
      await Promise.all(
        targetFiles.map(async (file) => ((await Bun.file(file).exists()) ? file : null))
      )
    ).filter((file): file is string => file !== null);
    if (targetFiles.length === 0) {
      log('No valid files provided');
      return;
    }
  } else {
    // Fall back to changed files
    targetFiles = await getChangedFiles(gitRoot, baseBranch);
    if (targetFiles.length === 0) {
      log('No changed files found');
      return;
    }
    // Convert to absolute paths
    targetFiles = targetFiles.map((file) => path.resolve(gitRoot, file));
  }

  const doubleSlash = /\/\/\s*.*$/gm;
  const hash = /#\s*.*$/gm;

  const commentPatterns: { [ext: string]: RegExp } = {
    '.svelte': doubleSlash,
    '.tsx': doubleSlash,
    '.jsx': doubleSlash,
    '.js': doubleSlash,
    '.ts': doubleSlash,
    '.py': hash,
    '.rs': doubleSlash,
    '.go': doubleSlash,
    '.kt': doubleSlash,
    '.swift': doubleSlash,
    '.c': doubleSlash,
    '.h': doubleSlash,
    '.hpp': doubleSlash,
    '.cpp': doubleSlash,
    '.cc': doubleSlash,
  };
  const supportedExtensions = Object.keys(commentPatterns);

  for (const fullPath of targetFiles) {
    const relativePath = path.relative(gitRoot, fullPath);
    const ext = path.extname(fullPath);
    if (!supportedExtensions.includes(ext)) {
      debugLog(`Skipping file with unsupported extension: ${relativePath}`);
      continue;
    }

    let content = await Bun.file(fullPath).text();
    let lines = content.split('\n');
    let linesCleaned = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip empty lines or lines that are only comments
      if (!line.trim() || line.trim().startsWith(commentPatterns[ext].source.slice(0, 2))) {
        continue;
      }

      // Check if line has code followed by a comment
      const match = line.match(commentPatterns[ext]);
      if (match && line.trim().length > match[0].length) {
        // Remove the comment part
        lines[i] = line.replace(commentPatterns[ext], '').trimEnd();
        linesCleaned++;
      }
    }

    if (linesCleaned) {
      await Bun.write(fullPath, lines.join('\n'));
      log(`${relativePath}: Cleaned ${linesCleaned} end-of-line comments`);
    }
  }
}
