# Safe Path Handling

Guidance for code that resolves, validates, or recursively deletes filesystem paths — especially when the path comes (directly or indirectly) from user-supplied configuration.

Read this before:

- Writing a runner that clears or rewrites a user-configurable directory.
- Adding a "this path must live inside X" containment check.
- Building a denylist of reserved path names.

## Containment Checks

### `path.relative(...).startsWith('..')` is wrong

```ts
const rel = path.relative(root, candidate);
if (rel.startsWith('..')) {
  /* outside root */
} // BUG
```

Directory names like `..foo` produce a relative path that begins with `..` but is fully inside `root`, so legitimate paths get rejected. Use:

```ts
if (rel === '..' || rel.startsWith('..' + path.sep)) {
  /* outside root */
}
```

Reject absolute candidates first (`path.isAbsolute`) so the relative check only has to handle the in-tree case.

### Symlinks defeat `path.resolve` + `path.relative`

Even after `realpath` validation on the directory root, an in-workspace symlink can still let a "clear directory" operation escape into unintended files. If the operation is destructive, walk every component of the resolved path with `fs.lstat` and reject any symlink before recursing. `realpath` on the directory itself is not sufficient — the symlink may be a child created after validation.

## Denylists

Path-segment denylists must be checked **case-insensitively** when the runtime might be on a case-insensitive filesystem (macOS default, Windows). `.tim/CONFIG` resolves to the real `.tim/config` on those filesystems, so a strict-equality check like `segment === 'config'` is bypassed by a trivial typo. Lowercase both sides before comparing.

## Prefer a Narrow Safe Namespace

When a runner recursively clears a user-configured directory, restricting the allowed path to a narrow namespace (e.g. "strict descendants of `.tim/`, minus tim-managed children like `config`, `plans`, `logs`, `tmp`") is more robust than enumerating dangerous paths. The denylist of "bad places" is unbounded; the allowlist of "places this feature owns" is small and stable.

A concrete example lives in `src/tim/proof/runner.ts` (the `artifactsDir` validator) — it requires the directory to be a strict descendant of `.tim/`, rejects reserved tim-managed children case-insensitively, rejects absolute paths and `..` escapes, and `lstat`s every component before clearing.

## tim Config Location

The canonical tim config file is `.tim/config/tim.yml`, **not** `.tim/config.yml`. Cross-check any new user-facing error message or doc reference against `loadEffectiveConfig` in `src/tim/configLoader.ts` before merging.
