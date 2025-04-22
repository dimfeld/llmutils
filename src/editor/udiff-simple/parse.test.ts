import { test, expect } from 'bun:test';
import { findDiffs } from './parse';

test('find_diffs single hunk', () => {
  const content = `
Some text...

\`\`\`diff
--- file.txt
+++ file.txt
@@ ... @@
-Original
+Modified
\`\`\`
`;
  const edits = findDiffs(content);
  console.log(edits); // Replacing dump with console.log for debugging
  expect(edits.length).toBe(1);

  const edit = edits[0];
  expect(edit.filePath).toBe('file.txt');
  expect(edit.hunk).toEqual(['-Original\n', '+Modified\n']);
});

test('find_diffs dev null', () => {
  const content = `
Some text...

\`\`\`diff
--- /dev/null
+++ file.txt
@@ ... @@
-Original
+Modified
\`\`\`
`;
  const edits = findDiffs(content);
  console.log(edits);
  expect(edits.length).toBe(1);

  const edit = edits[0];
  expect(edit.filePath).toBe('file.txt');
  expect(edit.hunk).toEqual(['-Original\n', '+Modified\n']);
});

test('find_diffs dirname with spaces', () => {
  const content = `
Some text...

\`\`\`diff
--- dir name with spaces/file.txt
+++ dir name with spaces/file.txt
@@ ... @@
-Original
+Modified
\`\`\`
`;
  const edits = findDiffs(content);
  console.log(edits);
  expect(edits.length).toBe(1);

  const edit = edits[0];
  expect(edit.filePath).toBe('dir name with spaces/file.txt');
  expect(edit.hunk).toEqual(['-Original\n', '+Modified\n']);
});

test('find multi diffs', () => {
  const content = `
To implement the \`--check-update\` option, I will make the following changes:

1. Add the \`--check-update\` argument to the argument parser in \`aider/main.py\`.
2. Modify the \`check_version\` function in \`aider/versioncheck.py\` to return a boolean indicating whether an update is available.
3. Use the returned value from \`check_version\` in \`aider/main.py\` to set the exit status code when \`--check-update\` is used.

Here are the diffs for those changes:

\`\`\`diff
--- aider/versioncheck.py
+++ aider/versioncheck.py
@@ ... @@
     except Exception as err:
         print_cmd(f"Error checking pypi for new version: {err}")
+        return False

--- aider/main.py
+++ aider/main.py
@@ ... @@
     other_group.add_argument(
         "--version",
         action="version",
         version=f"%(prog)s {__version__}",
         help="Show the version number and exit",
     )
+    other_group.add_argument(
+        "--check-update",
+        action="store_true",
+        help="Check for updates and return status in the exit code",
+        default=False,
+    )
     other_group.add_argument(
         "--apply",
         metavar="FILE",
\`\`\`

These changes will add the \`--check-update\` option to the command-line interface and use the \`check_version\` function to determine if an update is available, exiting with status code \`0\` if no update is available and \`1\` if an update is available.
`;

  const edits = findDiffs(content);
  console.log(edits);
  expect(edits.length).toBe(2);
  expect(edits[0].hunk.length).toBe(3);
});
