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
- JJ-mode PR creation prompts that build a "commits in this PR" preview must compute the comparison revset (`latest(ancestors(<base>) & ancestors(@))`) against the **resolved PR base**, not `trunk()`. Hardcoding `trunk()` makes a stacked PR's prompt list the predecessor's commits even though `gh pr create --base` targets the predecessor's branch. The base used here must match what's passed to `gh pr create --base`.

## Base Branch Resolution Across Surfaces

Multiple surfaces independently derive a plan's effective base branch: workspace setup (`resolveWorkspaceBranchContext` in `workspace_setup.ts`), `tim rebase`, and `tim pr create` / `autoCreatePrForPlan` (the `gh pr create --base` argument). Adding a new plan-level reference that affects base branch (e.g. `basePlan`) requires resolving the reference at **every** call site. Persisting the resolved value into a sibling field (like copying a resolved branch into `baseBranch`) can paper over the missed surfaces but turns a soft reference into a stale hard-coded value — subsequent edits to the reference silently have no effect. Prefer a shared resolver helper called fresh at each surface.

When the new resolution branch sits next to an existing one (e.g. `getBasePlanBranch` next to `getParentPlanBranch`), keep error semantics identical. Wrapping the new branch in try/catch while the sibling lets errors propagate creates inconsistent debugging behavior — transient lookup failures silently disappear for one source but surface for the other. Mirror the sibling exactly unless there is a documented reason to diverge.

## Null vs Undefined for Tracking Fields

- `setPlanBaseTracking` treats `null` as "clear this field" and `undefined` as "don't touch." Use `undefined` (not `null`) for fields that aren't applicable (e.g., `baseChangeId` in non-JJ repos) to avoid accidentally clearing stored values.
- Never persist null tracking values from transient failures — guard writes with null checks to preserve existing valid data.

## DB-Managed Fields and File Sync

- DB-only updates to plan fields (like base tracking via `setPlanBaseTracking`) leave materialized plan files stale. Always rematerialize after DB updates when the file needs to reflect the change.
- For machine-managed fields (like `baseCommit`, `baseChangeId`), prefer DB state over file state. The file→DB sync pipeline skips these fields to prevent stale file data from overwriting DB values.
