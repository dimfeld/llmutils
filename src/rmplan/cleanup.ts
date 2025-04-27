import { generateText } from 'ai';
import { createModel } from '../common/model_factory.js';
import { planExampleFormatGeneric } from './prompt.js';

// Define the prompt for Markdown to YAML conversion
const markdownToYamlConversionPrompt = `You are an AI assistant specialized in converting structured Markdown text into YAML format. Your task is to convert the provided Markdown input into YAML, strictly adhering to the specified schema. You should use a fast model like Gemini Flash 2.0 for this conversion.

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
4.  **Handle Multi-line Strings:** For step prompts (often found in Markdown code blocks or as multi-line list items), use the YAML pipe character (|) for multi-line strings.
5.  **Indentation:** Use exactly 2 spaces for YAML indentation levels.
6.  **Output Format:** Output *only* the raw, valid YAML string. Do **not** include any introductory text, explanations, comments, or Markdown fences (like \`\`\`yaml or \`\`\`).

**Example Input (Markdown):**
See the structure in the provided Markdown input text.
**Required Output (YAML):**
A single block of valid YAML text conforming to the schema.`;

export async function convertMarkdownToYaml(markdownInput: string): Promise<string> {
  const prompt = markdownToYamlConversionPrompt.replace('{markdownInput}', markdownInput);
  let { text } = await generateText({
    model: createModel('google/gemini-flash-2.0-preview-preview'), // Using Gemini Flash as requested
    prompt,
  });

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
  } else if (startIndex < 0) {
    // If 'goal:' is not found, return the trimmed text, maybe log a warning later
    console.warn("YAML output from LLM doesn't start with 'goal:'. Returning trimmed output.");
  }

  return text;
}
