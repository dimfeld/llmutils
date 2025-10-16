import { parseReviewerOutput } from './src/rmplan/formatters/review_formatter.ts';
const review = `## Found Issues:\n\n---\n\n1. CRITICAL: Missing error reporting in settings form action\n\nIn file.ts, line 59: The error handler is not called.\n\n} catch (error) {\n  return setError(form, 'Failed to update  email');\n}\n\nWhile the user gets feedback via setError, the actual error information is lost. \n\n} catch (error) {\n  locals.reportError?.(error);\n  return setError(form, 'Failed to update purchase order email');\n}\n\n---\n\n2. MINOR: Permission pattern inconsistency\n\nThe permission array pattern in +layout.svelte at line 244 does not use the constant. Use this instead:\n\nif(user.hasPermissions(billingPermissions)) {\n\nThis ensures permission consistency and makes maintenance easier.\n\n---\n\n**VERDICT:** NEEDS_FIXES\n\n- Summary: Implementation has critical security issues.\n- Suggested follow-up: Add logging around the failing branch.\n\nOverall, the implementation has critical security issues.\n`;
const result = parseReviewerOutput(review);
console.log(result.issues.length);
console.log(
  JSON.stringify(
    result.issues.map((i) => i.content),
    null,
    2
  )
);
