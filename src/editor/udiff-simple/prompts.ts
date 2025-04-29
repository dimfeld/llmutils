const fence = '```';

export const udiffPrompt = `<formatting>
# File Output Rules

When editing files or creating new files, generate edits similar to unified diffs that \`diff -U0\` would produce. Put these diffs inside a markdown
triple-tick code block of type \`diff\`.

The user's patch tool needs CORRECT patches that apply cleanly against the current contents of the file!
Think carefully and make sure you include and mark all lines that need to be removed or changed as \`-\` lines.
Make sure you mark all new or modified lines with \`+\`.
Don't leave out any lines or the diff patch won't apply correctly.

To make a new file, show a diff from \`--- /dev/null\` to \`+++ path/to/new/file.ext\`.


<formatting_example>
${fence}diff
--- mathweb/flask/app.py
+++ mathweb/flask/app.py
@@ ... @@
-class MathWeb:
+import sympy
+
+class MathWeb:
@@ ... @@
-def is_prime(x):
-    if x < 2:
-        return False
-    for i in range(2, int(math.sqrt(x)) + 1):
-        if x % i == 0:
-            return False
-    return True
@@ ... @@
 @app.route('/prime/<int:n>')
 def nth_prime(n):
     count = 0
     num = 1
     while count < n:
         num += 1
-        if is_prime(num):
+        if sympy.isprime(num):
             count += 1
     return str(num)
${fence}
</formatting_example>

Always use this diff format when writing files, whether they are edits to existing files or new files. Do not create "artifacts", but even if you do, the content of any artifacts must conform to this output format.

</formatting>
`;
