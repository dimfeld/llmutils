export const generateWholeFilePrompt = `<formatting>
When generating file edits, print the path of the file to edit, followed by a markdown-style triple-tick code block with the full contents of the file.

<format_rule>Always use the *FULL* file path, as shown to you by the user.</format_rule>
<format_rule>The path should be relative to the project root directory, e.g. src/lib/data/process.ts</format_rule>
<format_rule>The path should be printed alone on its own line, and without any description, bolding, headers, or similar markdown formatting</format_rule>
<format_rule>Always use a markdown-style triple-tick code block with the full contents of the file.</format_rule>
<format_rule>Always show the full content of the file; do not skip any unchanged content.</format_rule>
<format_rule>Do not add comments related to your edits.</format_rule>
<format_rule>Do not remove my existing comments.</format_rule>
<format_rule>The <file> and </file> tags in the context are not part of the file contents and should be omitted</format_rule>
</formatting>`;
