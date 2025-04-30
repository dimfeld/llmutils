import { streamText } from 'ai';
import { createModel } from '../common/model_factory.js';
import { planExampleFormatGeneric } from './prompt.js';
import { CURRENT_DIFF, getChangedFiles } from '../rmfilter/additional_docs.ts';
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

const doubleSlash = /\/\/\s*.*$/;
const slashStar = /\/\*[\s\S]*?\*\//;
const hash = /#\s*.*$/gm;
// Gemini sometimes adds comments like {/* ... */} which are not valid syntax
const invalidSvelteTemplateComment = /\{\/\*([\s\S]+)\*\/\}/;

const commentPatterns: { [ext: string]: RegExp[] } = {
  '.svelte': [invalidSvelteTemplateComment, doubleSlash, slashStar],
  '.tsx': [doubleSlash, slashStar],
  '.jsx': [doubleSlash, slashStar],
  '.js': [doubleSlash, slashStar],
  '.ts': [doubleSlash, slashStar],
  '.py': [hash],
  '.rs': [doubleSlash, slashStar],
  '.go': [doubleSlash, slashStar],
  '.kt': [doubleSlash, slashStar],
  '.swift': [doubleSlash, slashStar],
  '.c': [doubleSlash, slashStar],
  '.h': [doubleSlash, slashStar],
  '.hpp': [doubleSlash, slashStar],
  '.cpp': [doubleSlash, slashStar],
  '.cc': [doubleSlash, slashStar],
};

/**
 * Cleans end-of-line comments from a string based on file extension
 * @param content The file content to clean
 * @param ext The file extension (e.g., '.ts', '.py')
 * @returns Object containing cleaned content and number of lines cleaned
 */
export function cleanComments(
  content: string,
  ext: string
): { cleanedContent: string; linesCleaned: number } | undefined {
  if (!Object.keys(commentPatterns).includes(ext)) {
    return;
  }

  let lines = content.split('\n');
  let linesCleaned = 0;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // Skip empty lines
    let trimmed = line.trimStart();
    if (!trimmed) {
      continue;
    }

    // Check each pattern for this extension
    for (const pattern of commentPatterns[ext]) {
      // Special case for invalid Svelte template comments since they happen on standalone lines and can be fixed.
      const match = line.match(pattern);
      if (match && pattern === invalidSvelteTemplateComment) {
        let startIndex = match.index;
        lines[i] = lines[i].slice(0, startIndex) + `<!--${match[1]}-->`;
        linesCleaned++;
        break;
      }

      // Check if line has code followed by a comment
      if (match && trimmed.length > match[0].length) {
        // Remove the comment part
        line = line.replace(pattern, '').trimEnd();
        lines[i] = line;
        linesCleaned++;
        break;
      }
    }
  }

  if (!linesCleaned) {
    return;
  }

  return { cleanedContent: lines.join('\n'), linesCleaned };
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
    targetFiles = files.map((file) => path.resolve(process.cwd(), file));
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
    targetFiles = await getChangedFiles(gitRoot, baseBranch || CURRENT_DIFF);
    if (targetFiles.length === 0) {
      log('No changed files found');
      return;
    }
    // Convert to absolute paths
    targetFiles = targetFiles.map((file) => path.resolve(gitRoot, file));
  }

  const supportedExtensions = Object.keys(commentPatterns);

  for (const fullPath of targetFiles) {
    const relativePath = path.relative(gitRoot, fullPath);
    const ext = path.extname(fullPath);
    if (!supportedExtensions.includes(ext)) {
      debugLog(`Skipping file with unsupported extension: ${relativePath}`);
      continue;
    }

    debugLog(`${relativePath}: Cleaning end-of-line comments`);

    let content = await Bun.file(fullPath).text();
    const result = cleanComments(content, ext);

    if (result) {
      const { cleanedContent, linesCleaned } = result;
      await Bun.write(fullPath, cleanedContent);
      log(`${relativePath}: Cleaned ${linesCleaned} end-of-line comments`);
    }
  }
}
