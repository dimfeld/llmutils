import { generateText } from 'ai';
import { createModel } from '../common/model_factory.js';
import { planExampleFormatGeneric } from './prompt.js';

function cleanupPrompt(input: string) {
  const exampleFormat = planExampleFormatGeneric
    .split('\n')
    .map((line) => '  ' + line)
    .join('\n');

  return `You are a YAML formatting expert. Your task is to clean up and format the given text into valid YAML. Pay close attention to the structure, indentation, and proper use of quotes and multi-line string formatting.

Here is the text that needs to be converted to valid YAML:

<input_text>
${input}
</input_text>

Before formatting the YAML, analyze the input and plan your approach inside yaml_analysis tags:

1. Identify and list key-value pairs from the input text
2. Note any structural inconsistencies or formatting issues
3. Plan how to reorganize the content to fit the required YAML structure
4. Identify the overall structure of the YAML
5. List any strings that need to be quoted
6. Identify any multi-line strings that require the pipe character
7. Note any indentation issues that need to be corrected
8. Check if the structure matches the expected format (goal, details, tasks)
9. Plan how to handle any missing or extra fields
10. Count the number of tasks in the input

Now, format the input text into valid YAML according to the following guidelines:

1. Ensure the YAML structure matches this format:
   \`\`\`yaml
${exampleFormat}
   \`\`\`

2. Use quotes for strings containing special characters or when necessary to avoid YAML parsing errors.

3. For multi-line strings, use the pipe character (|) followed by the indented text on subsequent lines.

4. Ensure proper indentation: Use 2 spaces for each level of indentation.

5. For lists (such as 'files' and 'steps'), use a hyphen (-) followed by a space for each item.

6. If any required fields are missing in the input, include them with empty values.

7. Remove any fields that don't match the expected structure.

Output only the cleaned and formatted YAML, without any additional explanations or comments.`;
}

export async function cleanupYaml(input: string) {
  const prompt = cleanupPrompt(input);
  const result = await generateText({
    model: createModel('gemini-2.5-flash-preview-04-17'),
    prompt,
  });
  return result.text;
}
