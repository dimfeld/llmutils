import { generateText } from 'ai';
import { createModel } from '../common/model_factory.js';
import { planExampleFormatGeneric } from './prompt.js';

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
6.  **Output Format:** Output *only* the raw, valid YAML string. Do **not** include any introductory text, explanations, comments, or Markdown fences (like \`\`\`yaml or \`\`\`).

**Example Input (Markdown):**
See the structure in the provided Markdown input text.
**Required Output (YAML):**
A single block of valid YAML text conforming to the schema.`;

export async function convertMarkdownToYaml(markdownInput: string): Promise<string> {
  const prompt = markdownToYamlConversionPrompt.replace('{markdownInput}', markdownInput);
  let { text } = await generateText({
    model: createModel('google/gemini-2.5-flash-preview-04-17'),
    prompt,
  });

  return findYamlStart(text);
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
