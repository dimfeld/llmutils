# Using Pierre Diffs with Svelte (via Vanilla JS API + Attachments)

Pierre Diffs (`@pierre/diffs`) is a diff and file rendering library that provides vanilla JS classes with imperative `render()` / `cleanUp()` lifecycle methods. This maps naturally onto Svelte's [attachment](https://svelte.dev/docs/svelte/attachments) pattern, giving you reactive diff rendering without any wrapper components.

## Installation

```bash
bun add @pierre/diffs
```

The vanilla JS API is the default export:

| Package                | Description                                    |
| ---------------------- | ---------------------------------------------- |
| `@pierre/diffs`        | Vanilla JS components and utilities            |
| `@pierre/diffs/worker` | Worker pool for offloading syntax highlighting |
| `@pierre/diffs/ssr`    | Server-side rendering utilities                |

## Core Concepts

### FileContents

A simple object representing a file:

```ts
import type { FileContents } from '@pierre/diffs';

const file: FileContents = {
  name: 'example.ts',
  contents: 'console.log("hello")',
  lang: 'typescript', // optional, detected from filename
  cacheKey: 'example-v1', // optional, for AST caching with Worker Pool
};
```

### FileDiffMetadata

Represents the differences between two files. You typically don't construct this manually — use `parseDiffFromFile()` or `parsePatchFiles()` to generate it.

### Creating Diffs

**From two files** (enables "expand unchanged" feature):

```ts
import { parseDiffFromFile } from '@pierre/diffs';
const diff = parseDiffFromFile(oldFile, newFile);
```

**From a patch string** (unified diff / git output):

```ts
import { parsePatchFiles } from '@pierre/diffs';
const patches = parsePatchFiles(patchString);
const files = patches[0].files; // FileDiffMetadata[]
```

## Basic Attachment: FileDiff

The `FileDiff` class has three lifecycle phases: `new FileDiff(options)`, `instance.render(data)`, and `instance.cleanUp()`. A Svelte attachment wraps this perfectly.

```svelte
<script lang="ts">
  import { FileDiff, type FileContents } from '@pierre/diffs';

  let { oldFile, newFile }: { oldFile: FileContents; newFile: FileContents } = $props();

  function fileDiffAttachment(node: HTMLElement) {
    const instance = new FileDiff({
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      diffStyle: 'split',
    });

    instance.render({
      oldFile,
      newFile,
      containerWrapper: node,
    });

    return () => {
      instance.cleanUp();
    };
  }
</script>

<div {@attach fileDiffAttachment}></div>
```

> **Reference stability matters.** `FileDiff` uses reference equality on `oldFile` / `newFile` to skip unnecessary re-renders. Keep your `FileContents` objects stable — don't recreate them on every render.

## Reactive Updates with $effect

To respond to prop changes (e.g. switching between files, changing diff style), use `$effect` inside the attachment:

```svelte
<script lang="ts">
  import { FileDiff, type FileContents } from '@pierre/diffs';

  let {
    oldFile,
    newFile,
    diffStyle = 'split',
  }: {
    oldFile: FileContents;
    newFile: FileContents;
    diffStyle?: 'split' | 'unified';
  } = $props();

  function fileDiffAttachment(node: HTMLElement) {
    const instance = new FileDiff({
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      diffStyle,
    });

    instance.render({
      oldFile,
      newFile,
      containerWrapper: node,
    });

    $effect(() => {
      // Rerender when files or style changes
      instance.setOptions({ ...instance.options, diffStyle });
      instance.render({
        oldFile,
        newFile,
        containerWrapper: node,
      });
    });

    return () => {
      instance.cleanUp();
    };
  }
</script>

<div {@attach fileDiffAttachment}></div>
```

The `$effect` will re-run whenever any reactive values it reads (`oldFile`, `newFile`, `diffStyle`) change.

## Single File Rendering

The `File` class renders a single file with syntax highlighting (no diff):

```svelte
<script lang="ts">
  import { File as PierreFile, type FileContents } from '@pierre/diffs';

  let { file }: { file: FileContents } = $props();

  function fileAttachment(node: HTMLElement) {
    const instance = new PierreFile({
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      overflow: 'scroll',
    });

    instance.render({
      file,
      containerWrapper: node,
    });

    $effect(() => {
      instance.render({
        file,
        containerWrapper: node,
      });
    });

    return () => {
      instance.cleanUp();
    };
  }
</script>

<div {@attach fileAttachment}></div>
```

## Rendering from Patch Strings

When you have a unified diff string (e.g. from `git diff` output), parse it into `FileDiffMetadata` first:

```svelte
<script lang="ts">
  import { FileDiff, parsePatchFiles } from '@pierre/diffs';

  let { patch }: { patch: string } = $props();

  function patchDiffAttachment(node: HTMLElement) {
    const instance = new FileDiff({
      theme: 'pierre-dark',
    });

    // parsePatchFiles returns ParsedPatch[], each containing a files array
    const parsed = parsePatchFiles(patch);

    // Render the first file's diff
    if (parsed[0]?.files[0]) {
      instance.render({
        fileDiff: parsed[0].files[0],
        containerWrapper: node,
      });
    }

    return () => {
      instance.cleanUp();
    };
  }
</script>

<div {@attach patchDiffAttachment}></div>
```

For **multiple files** in a patch, render each one separately:

```svelte
<script lang="ts">
  import { FileDiff, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';

  let { patch }: { patch: string } = $props();

  let files: FileDiffMetadata[] = $derived(parsePatchFiles(patch).flatMap((p) => p.files));

  function fileDiffAttachment(fileDiff: FileDiffMetadata) {
    return (node: HTMLElement) => {
      const instance = new FileDiff({
        theme: { dark: 'pierre-dark', light: 'pierre-light' },
      });

      instance.render({ fileDiff, containerWrapper: node });

      return () => instance.cleanUp();
    };
  }
</script>

{#each files as fileDiff (fileDiff.name)}
  <div {@attach fileDiffAttachment(fileDiff)}></div>
{/each}
```

## Interactive Features

### Line Selection

```svelte
<script lang="ts">
  import { FileDiff, type FileContents } from '@pierre/diffs';

  let { oldFile, newFile }: { oldFile: FileContents; newFile: FileContents } = $props();
  let selectedRange = $state<{ start: number; end: number; side: string } | null>(null);

  function fileDiffAttachment(node: HTMLElement) {
    const instance = new FileDiff({
      theme: 'pierre-dark',
      enableLineSelection: true,
      onLineSelected(range) {
        selectedRange = range;
      },
    });

    instance.render({ oldFile, newFile, containerWrapper: node });

    return () => instance.cleanUp();
  }
</script>

<div {@attach fileDiffAttachment}></div>
{#if selectedRange}
  <p>Selected lines {selectedRange.start}–{selectedRange.end} on {selectedRange.side}</p>
{/if}
```

### Gutter Utility Button (e.g. Add Comment)

```ts
const instance = new FileDiff({
  theme: 'pierre-dark',
  enableGutterUtility: true,
  onGutterUtilityClick(range) {
    // range: { start, end, side, endSide }
    console.log('Add comment at', range);
  },
});
```

### Line Annotations

Render annotations (like review comments) attached to specific lines:

```ts
instance.render({
  oldFile,
  newFile,
  containerWrapper: node,
  lineAnnotations: [{ side: 'additions', lineNumber: 5, metadata: { threadId: 'abc' } }],
});

// Update annotations later:
instance.setLineAnnotations([
  { side: 'additions', lineNumber: 5, metadata: { threadId: 'abc' } },
  { side: 'additions', lineNumber: 12, metadata: { threadId: 'def' } },
]);
```

Provide a `renderAnnotation` callback in options to control how annotations display:

```ts
const instance = new FileDiff({
  // ...
  renderAnnotation(annotation) {
    const el = document.createElement('div');
    el.textContent = `Thread: ${annotation.metadata.threadId}`;
    return el;
  },
});
```

### Mounting Svelte Annotation Components

Pierre's `renderAnnotation(annotation)` callback must return a plain DOM node. For review pages that need richer annotation UI, use `createAnnotationRenderer({ onAnnotationClick })` from `src/routes/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/annotation_mount_helper.ts`:

- Mounted components are tracked by annotation key (`issueId-side-lineNumber`). When Pierre re-renders the same key, the previous mount is torn down and a fresh one is mounted — do not assume components persist across renders.
- `syncRenderPass(requestedKeys)` is invoked by the page after each render pass with the set of keys that should remain mounted; any tracked key not in the set is disposed. This prevents leaks when issues are edited or removed (Pierre does not notify the helper of removals).
- `getNodeForIssue(issueId)` is a separate DOM-node lookup keyed by issue id. Its only purpose is to let pages find the live mount root for programmatic scroll/highlight (for example, card → diff "Jump to diff"). When an issue has multiple mounted annotations and one is disposed, the map is repointed to another live entry; when the last entry for an issue is disposed, the mapping is dropped.
- `disposeAll()` tears down all remaining mounts on component destroy.

Shadow DOM caveat: Pierre renders inside a shadow root, so document-level stylesheets do not reach annotation nodes. Use inline styles or scoped Pierre CSS variables. For temporary jump/highlight effects, apply inline styles directly to the mount root.

Svelte 5 note: `unmount()` returns a Promise. Cleanup failures are non-actionable here, so handle with `.catch(() => {})` — `try { unmount(...) } catch` will not catch the async rejection.

Secondary lookup maps (e.g. `nodesByIssue` alongside `entries` keyed by annotation key) must be repointed on every dispose path: if one of an issue's multiple annotations is disposed while a sibling survives, point the lookup at the surviving entry. "Stop tracking only when empty" leaves the map pointing at detached DOM nodes and callers silently no-op. Pair every "dispose X" with "if the public lookup named X, repoint or clear it."

### Gutter Range Normalization

`onGutterUtilityClick(range)` and `onLineSelected(range)` return `{ start, end, side, endSide }`. Two traps:

- The user can drag upward, producing a range where `end < start`. Normalize with `Math.min(start, end)` / `Math.max(start, end)` before using it as a GitHub comment anchor.
- `side` and `endSide` can differ when the user drags across the LEFT/RIGHT gutter boundary. A single-side comment anchor cannot span both sides — explicitly reject mixed-side ranges (return `null` and bail out of the affordance) rather than silently falling back to one side.

### Parsing Patch Filenames

Patches for deleted files have `+++ /dev/null`. A parser that only reads `+++ b/<file>` silently fails on deletions. Parse both `+++` and `---` and fall back to the other header when one is `/dev/null`.

### Fetching SHA-Anchored Diffs

`octokit.rest.pulls.get({ mediaType: { format: 'diff' } })` always returns the diff for the PR's current head, regardless of any SHA you pass alongside. For inline review comments to apply, the diff must match the commit you're anchoring against.

Use `octokit.rest.repos.compareCommitsWithBasehead({ basehead: '<baseBranch>...<commitSha>', mediaType: { format: 'diff' } })` instead. A "fetch the PR diff" helper that takes only `prUrl` is an anti-abstraction — require `baseBranch` and `commitSha` as explicit inputs; branch _names_ are not part of the diff's identity.

For the same reason, **do not cache diff responses across requests**. The diff depends on both base-branch and head-branch SHAs, either of which can advance. If cross-request caching is tempting, key on `(owner, repo, baseSha, headSha)` — never on branch names or PR URLs alone — and default to skipping the cache.

### Pierre Shadow DOM Theming

Pierre mounts annotations inside a shadow root. Document-level stylesheets and CSS variables defined on `:root` do **not** reach annotation nodes — only variables defined inside Pierre's shadow root apply. For theme-dependent visual effects on annotations, apply inline styles directly to the mount root, and pick colors that read on both light and dark Pierre themes (amber/gold works on both; saturated blue on blue does not).

### Mouse Events

```ts
const instance = new FileDiff({
  theme: 'pierre-dark',
  lineHoverHighlight: 'both', // 'disabled' | 'both' | 'number' | 'line'
  onLineClick({ lineNumber, side, event }) {
    /* ... */
  },
  onLineEnter({ lineNumber, side }) {
    /* ... */
  },
  onLineLeave({ lineNumber, side }) {
    /* ... */
  },
});
```

### Post-Render DOM Access

Use `onPostRender` to inspect or manipulate the shadow DOM after rendering:

```ts
const instance = new FileDiff({
  theme: 'pierre-dark',
  onPostRender(node, fileDiffInstance) {
    const codeLines = node.shadowRoot?.querySelectorAll('[data-line]');
    console.log('rendered lines:', codeLines?.length ?? 0);
  },
});
```

## Styling

Diffs renders into Shadow DOM, so page CSS won't leak in. Customize via CSS custom properties on a parent element or `:root`:

```css
:root {
  --diffs-font-family: 'Berkeley Mono', monospace;
  --diffs-font-size: 14px;
  --diffs-line-height: 1.5;
  --diffs-tab-size: 2;
  --diffs-header-font-family: Helvetica;
  --diffs-min-number-column-width: 3ch;

  /* Override diff colors (normally inherited from the Shiki theme) */
  --diffs-deletion-color-override: /* ... */;
  --diffs-addition-color-override: /* ... */;
  --diffs-modified-color-override: /* ... */;

  /* Line selection colors */
  --diffs-selection-color-override: rgb(37, 99, 235);
  --diffs-bg-selection-override: rgba(147, 197, 253, 0.28);

  /* Layout */
  --diffs-gap-inline: 8px;
  --diffs-gap-block: 8px;
}
```

Or scope them to a wrapper element:

```svelte
<div
  style="--diffs-font-family: 'JetBrains Mono', monospace; --diffs-font-size: 13px;"
  {@attach fileDiffAttachment}
></div>
```

### Unsafe CSS Escape Hatch

For advanced shadow DOM customization, use `unsafeCSS` (wrapped in `@layer unsafe`). Use simple data-attribute selectors — avoid structural selectors (`:nth-child`, `+`, `~`), as internals may change:

```ts
const instance = new FileDiff({
  theme: 'pierre-dark',
  unsafeCSS: `
    [data-line-index='0'] {
      border-top: 1px solid var(--diffs-bg-context);
    }
    [data-line] {
      border-bottom: 1px solid var(--diffs-bg-context);
    }
  `,
});
```

## Virtualized Rendering (Large Files)

For large files/diffs, use `VirtualizedFileDiff` or `VirtualizedFile` with a `Virtualizer` and Worker Pool. This requires two container elements: a scroll root and a content container.

```svelte
<script lang="ts">
  import { Virtualizer, VirtualizedFileDiff, type FileContents } from '@pierre/diffs';
  import {
    getOrCreateWorkerPoolSingleton,
    terminateWorkerPoolSingleton,
  } from '@pierre/diffs/worker';
  import { onDestroy } from 'svelte';

  let { oldFile, newFile }: { oldFile: FileContents; newFile: FileContents } = $props();

  // Create worker pool once (module-level singleton)
  const workerPool = getOrCreateWorkerPoolSingleton({
    poolOptions: {
      workerFactory: () =>
        new Worker(new URL('@pierre/diffs/worker', import.meta.url), { type: 'module' }),
    },
    highlighterOptions: {
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      langs: ['typescript', 'javascript', 'css', 'html'],
    },
  });

  let scrollRoot: HTMLElement;
  let scrollContent: HTMLElement;
  let virtualizer: Virtualizer | null = null;
  let diffInstance: VirtualizedFileDiff | null = null;

  function scrollRootAttachment(node: HTMLElement) {
    scrollRoot = node;
  }

  function scrollContentAttachment(node: HTMLElement) {
    scrollContent = node;

    virtualizer = new Virtualizer({
      overscrollSize: 1000,
      intersectionObserverMargin: 4000,
    });
    virtualizer.setup(scrollRoot, scrollContent);

    diffInstance = new VirtualizedFileDiff(
      {
        theme: { dark: 'pierre-dark', light: 'pierre-light' },
        diffStyle: 'split',
      },
      virtualizer,
      { lineHeight: 22, fileGap: 10 },
      workerPool
    );

    diffInstance.render({
      oldFile,
      newFile,
      containerWrapper: scrollContent,
    });

    return () => {
      diffInstance?.cleanUp();
      virtualizer?.cleanUp();
    };
  }

  onDestroy(() => {
    // Only terminate if no other components use the pool
    // terminateWorkerPoolSingleton();
  });
</script>

<div {@attach scrollRootAttachment} style="height: 600px; overflow: auto;">
  <div {@attach scrollContentAttachment}></div>
</div>
```

### Virtualizer Options

| Option                       | Default | Description                                |
| ---------------------------- | ------- | ------------------------------------------ |
| `overscrollSize`             | `1000`  | Extra pixels rendered above/below viewport |
| `intersectionObserverMargin` | `4000`  | IntersectionObserver root margin (px)      |
| `resizeDebugging`            | `false` | Log size changes (disable in production)   |

## FileDiff Options Reference

### Theming

| Option                 | Default      | Description                                                                |
| ---------------------- | ------------ | -------------------------------------------------------------------------- |
| `theme`                | —            | `'pierre-dark'`, `'pierre-light'`, or `{ dark, light }` for auto-switching |
| `themeType`            | `'system'`   | `'system'`, `'dark'`, or `'light'`                                         |
| `preferredHighlighter` | `'shiki-js'` | `'shiki-js'` or `'shiki-wasm'`                                             |

### Diff Display

| Option              | Default      | Description                                                            |
| ------------------- | ------------ | ---------------------------------------------------------------------- |
| `diffStyle`         | `'split'`    | `'split'` (side-by-side) or `'unified'` (single column)                |
| `diffIndicators`    | `'bars'`     | `'bars'`, `'classic'` (+/- chars), or `'none'`                         |
| `disableBackground` | `false`      | Disable colored backgrounds on changed lines                           |
| `lineDiffType`      | `'word-alt'` | Inline change highlighting: `'word-alt'`, `'word'`, `'char'`, `'none'` |
| `maxLineDiffLength` | `1000`       | Skip inline diff for lines longer than this                            |

### Hunk Separators

| Option                      | Default       | Description                                                                        |
| --------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `hunkSeparators`            | `'line-info'` | `'line-info'`, `'line-info-basic'`, `'metadata'`, `'simple'`, or a custom function |
| `expandUnchanged`           | `false`       | Force unchanged context to always render                                           |
| `expansionLineCount`        | `100`         | Lines revealed per expand click                                                    |
| `collapsedContextThreshold` | `1`           | Auto-expand collapsed regions at or below this size                                |

### Layout

| Option                  | Default    | Description                                         |
| ----------------------- | ---------- | --------------------------------------------------- |
| `disableLineNumbers`    | `false`    | Hide line numbers                                   |
| `overflow`              | `'scroll'` | `'scroll'` or `'wrap'` for long lines               |
| `disableFileHeader`     | `false`    | Hide the file header                                |
| `collapsed`             | —          | Hide file body, keeping header visible              |
| `tokenizeMaxLineLength` | `1000`     | Skip syntax highlighting for lines longer than this |

### Header Customization

| Callback                         | Description                       |
| -------------------------------- | --------------------------------- |
| `renderHeaderPrefix(fileDiff)`   | Render before filename in header  |
| `renderHeaderMetadata(fileDiff)` | Render after diff stats in header |
| `renderCustomHeader(fileDiff)`   | Replace built-in header entirely  |

Each callback receives `FileDiffMetadata` and should return an `HTMLElement` or `DocumentFragment`.

### Instance Methods

| Method                                 | Description                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `render(data)`                         | Render with `{ oldFile, newFile }` or `{ fileDiff }`, plus `containerWrapper` and optional `lineAnnotations` |
| `rerender()`                           | Force re-render after option changes                                                                         |
| `setOptions(opts)`                     | Replace options (full replacement, not merge)                                                                |
| `setLineAnnotations(annotations)`      | Update annotations after initial render                                                                      |
| `setSelectedLines(range)`              | Programmatically select lines                                                                                |
| `expandHunk(index, direction, count?)` | Expand a collapsed hunk (`'up'`, `'down'`, or `'both'`)                                                      |
| `setThemeType(type)`                   | Switch theme: `'dark'`, `'light'`, or `'system'`                                                             |
| `cleanUp()`                            | Remove DOM, event listeners, clear state                                                                     |

## Utility Functions

| Function                                  | Description                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `parseDiffFromFile(oldFile, newFile)`     | Generate `FileDiffMetadata` from two `FileContents`                     |
| `parsePatchFiles(patch, cacheKeyPrefix?)` | Parse unified diff string into `ParsedPatch[]`                          |
| `setLanguageOverride(fileOrDiff, lang)`   | Change the language on an existing `FileContents` or `FileDiffMetadata` |
| `trimPatchContext(patch, lines)`          | Reduce context lines in a patch string                                  |
| `preloadHighlighter(options)`             | Warm up the syntax highlighter                                          |
| `getSharedHighlighter()`                  | Access the shared Shiki highlighter instance                            |
| `disposeHighlighter()`                    | Release the shared highlighter                                          |
| `registerCustomTheme(theme)`              | Register a custom Shiki-compatible theme                                |
| `registerCustomLanguage(lang)`            | Register a custom TextMate language grammar                             |
