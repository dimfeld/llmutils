import type { ModelPreset } from '../../rmfilter/config.ts';
import { noArtifacts } from '../fragments.ts';

export const generateWholeFilePrompt = (settings: ModelPreset) => `<formatting>
When generating file edits, print the path of the file to edit, followed by a markdown-style triple-tick code block with the full contents of the file.

<format_rule>Always use the *FULL* file path, as shown to you by the user.</format_rule>
<format_rule>Always include the file path, even if you are only generating a single file or if you are generting a new file.</format_rule>
<format_rule>The path should be relative to the project root directory, e.g. src/lib/data/process.ts</format_rule>
<format_rule>The path should be printed alone on its own line just before the file contents, and without any description, bolding, headers, or similar markdown formatting. The path should not be inside a code block.</format_rule>
<format_rule>Always show the full content of the file; do not skip any unchanged content.</format_rule>
<format_rule>Always put the file contents inside a markdown-style triple-tick code block.</format_rule>
<format_rule>Do not add comments related to your edits.</format_rule>
<format_rule>Do not remove my existing comments.</format_rule>
<format_rule>The <file> and </file> tags in the context are not part of the file contents and should be omitted</format_rule>
${settings.noArtifacts ? '<format_rule>' + noArtifacts + '</format_rule>' : ''}

<format_example>
apps/web/src/lib/data/process.ts
\`\`\`
import { process } from './process';

export function processData(data: string) {
  return process(data);
}
\`\`\`
</format_example>

<format_rule>If you are writing a markdown file, instead of triple-ticks, you can put the contents inside <file> and </file> tags so that any triple-ticks in the markdown do not end the file contents.</format_rule>

<format_example filetype="markdown">
<file path="apps/web/src/lib/data/process.md">
# My markdown file

This is a markdown file.

A code block:
\`\`\`
import { process } from './process';

export function processData(data: string) {
  return process(data);
}
\`\`\`
</file>
</format_example>
</formatting>`;
