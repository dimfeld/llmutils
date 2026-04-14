# Git and JJ Utility Patterns

Patterns and gotchas for working with Git and JJ in `src/common/git.ts` and related code.

## Remote Branch Existence Checking

- `git fetch origin <branch>` leaves stale `refs/remotes/origin/<branch>` refs when a branch is deleted upstream. **Never use local refs** to determine if a remote branch exists. Always use `git ls-remote` for remote-truth branch existence checking.
- `git ls-remote --exit-code --heads origin <branch>` returns exit code 2 for "no matching refs" vs other non-zero for transport errors. This distinction is useful for telling "branch deleted" from "remote unreachable" — callers should throw on transport errors rather than treating all failures as "branch missing."
- `jj git fetch --branch <nonexistent>` returns exit 0 (fetches nothing silently), so `fetchRemoteBranch` can't distinguish existing from missing for JJ. Use `remoteBranchExistsJj` (which checks `@origin` bookmarks) for existence checks instead.

## Merge Base Computation

- `getMergeBase` uses HEAD by default, which is wrong in non-workspace mode where the plan branch isn't checked out. Always pass the plan branch as an explicit source ref when the working copy may not match the target branch.
- The `useRemoteRef` option on `getMergeBase` controls whether `origin/` is prepended for Git refs. Some callers (e.g., `incremental_review.ts`) need local refs while others (e.g., `create_pr.ts`) need remote refs. Default is `true` (remote).

## JJ Bookmark Handling

- `jj bookmark set <name>` without `-r` moves the bookmark to `@` (the working copy), which creates synthetic empty revisions and can advance the bookmark past the intended target. Always use `-r <rev>` to specify the exact revision — e.g., `jj bookmark set <name> -r <name>@origin` to align a local bookmark with its remote version.
- When checking out a remote branch in JJ, the correct sequence is: (1) `jj bookmark track <name>@origin`, (2) `jj bookmark set <name> -r <name>@origin`, (3) `jj new <name>`. This avoids the bookmark advancing to the working copy.

## JJ Shell Command Gotchas

- JJ revsets with parentheses (e.g., `heads(::@ & ::<branch>)`) must be pre-built as a complete string before passing to Bun's shell template literals (`$\`...\``). Shell metacharacter parsing on `(` causes errors if the revset is interpolated piecemeal.

## Null vs Undefined for Tracking Fields

- `setPlanBaseTracking` treats `null` as "clear this field" and `undefined` as "don't touch." Use `undefined` (not `null`) for fields that aren't applicable (e.g., `baseChangeId` in non-JJ repos) to avoid accidentally clearing stored values.
- Never persist null tracking values from transient failures — guard writes with null checks to preserve existing valid data.

## DB-Managed Fields and File Sync

- DB-only updates to plan fields (like base tracking via `setPlanBaseTracking`) leave materialized plan files stale. Always rematerialize after DB updates when the file needs to reflect the change.
- For machine-managed fields (like `baseCommit`, `baseChangeId`), prefer DB state over file state. The file→DB sync pipeline skips these fields to prevent stale file data from overwriting DB values.
