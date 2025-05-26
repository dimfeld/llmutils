A .mdc file is a text file containing documentation or rules for using some part of the codebase, with a front matter style header with some attributes. We want rmfilter to automatically decide if .mdc files should be included when running. 

Specifically the idea of having a glob in the mdc file that matches against the active source files to determine if the doc gets included. 

Also add an option `--no-mdc` to suppress automatically including mdc files.

As part of this task, also clean up the `docsContent` in src/rmfilter/additional_docs.ts as follows:
- Use <documents> instead of <docs>
- Each document should be in its own <document> tag
- If we have a description for the document, as we might with .mdc files, it should be an attribute on the document tag.

Do something similar for the `rulesContent`.



# MDC Format description 

The `.mdc` (Markdown Domain Configuration) file format is used by Cursor, an AI-powered code editor, to define project-specific rules that guide the AI’s behavior, such as code generation, formatting, and context-aware assistance. These files are stored in the `.cursor/rules/` directory of a project and are written in a structured Markdown-based format. Below is a detailed description of the `.mdc` format, based on available information and best practices.

### Key Components of the `.mdc` Format

1. **Frontmatter (Metadata)**:
   - The file often starts with a YAML or TOML-like frontmatter section, enclosed in triple dashes (`---`), which provides metadata about the rule.
   - Common fields include:
     - `description`: A brief summary of the rule’s purpose, used by the AI to determine when to apply the rule.
     - `globs`: File patterns (e.g., `*.tsx`, `app/controllers/**/*.rb`) that specify which files the rule applies to. Globs use standard glob syntax and can include wildcards.
     - `name` (optional): A descriptive name for the rule.
     - `metadata` (optional): Additional details like `priority`, `version`, or `author`.
   - Example:
     ```markdown
     --- 
     description: Standards for React component files
     globs: *.tsx, *.ts
     name: react-components
     ---
     ```

2. **Body Text (Rules and Instructions)**:
   - The main content follows the frontmatter and contains the actual rules or guidelines in Markdown or plain text.
   - The body is typically concise (recommended under 25 lines) and uses Markdown formatting for readability, such as headers, lists, or code blocks.
   - Rules can include:
     - Coding standards (e.g., “Use functional components over class components in React”).
     - File referencing with `@` (e.g., `@docs/architecture/services.md` to include context from another file).
     - Specific instructions for the AI (e.g., “Always use TypeScript for new code”).
   - Example:
     ```markdown
     # React Component Rules
     - Use functional components.
     - Implement proper prop types.
     - Follow Tailwind CSS for styling.
     - Reference @tsconfig.json for type settings.
     ```

### Example `.mdc` File

Here’s a complete example combining common elements:

```markdown
---
description: Rules for Svelte components with Superform
globs: *.svelte, *.ts
type: docs
grep: superform, supervalidate
name: svelte-superform
metadata:
  priority: high
  version: 1.0
---
Docs for Superform would go here
```

# Additional MDC Fields to Support

In addition to the format description below, add a field that can grep for terms. e.g. "grep: superForm, supervalidate" in a file means to include it if an included source file contains the word superForm or supervalidate. Greps should match case-insensitive

Also support a `type` field that can be `docs` or `rules`, or variations on those terms. This will decide if the file
goes into the `docsContent` or `rulesContent` arrays.


# MDC File Locations

In addition to the standard file locations, also look in the `~/.config/rmfilter/rules` directory.
