# OS Process Interaction Gotchas

Notes for code in `src/common/` (and elsewhere) that interacts with OS process state — process listing, PID tracking, signals, and user-supplied matchers against process metadata. Most of this came out of building `subprocess_monitor.ts` and `process_listing.ts`.

## PID identity

A bare PID is not a stable identity. After a process exits, the kernel can reuse the same PID for an unrelated process, and within a single session you can also see the same command spawned twice with the same PID after the first instance dies. PID + command line is still not enough — the same command can be re-spawned.

The cheapest cross-platform disambiguator is `ps -o lstart=`: an opaque "process start time" string. Capture it alongside the PID and treat `(pid, command, lstart)` as the identity tuple. Compare all three before acting on a tracked PID (e.g. before sending SIGKILL during an escalation grace window). Never parse `lstart` — only compare it as an opaque string.

## `ps` invocation

Portable invocation across macOS (BSD `ps`) and Linux (procps):

```
ps -A -ww -o pid=,ppid=,lstart=,command=
```

- `-ww` disables column truncation. Without it, BSD `ps` will truncate the `command` column at terminal width, breaking substring matchers.
- The trailing `=` on each `-o` field suppresses the header row.
- `lstart` is fixed-width (24 chars) — parse the fixed columns, not whitespace-split.

Treat a transient `ps` failure (non-zero exit, parse error) as **unknown**, not **absent**. If a polling/escalation path drops tracked PIDs every time `ps` hiccups, a flaky listing cancels in-flight work. For liveness checks during a grace window, fall back to `kill(pid, 0)` rather than dropping the entry.

## Signal handling

- `process.kill(pid, 0)` is the canonical POSIX liveness check; use it before SIGKILL escalation to avoid noisy ESRCH errors.
- ESRCH on SIGTERM/SIGKILL means the process is already gone — silently clean up. Other errors should be logged, and any `killing` flag cleared so future polls can retry rather than getting stuck.
- Don't include the root/parent PID itself in any descendant action — BFS must explicitly exclude it.

## User-supplied regex/string matchers

When users provide patterns that you'll repeatedly evaluate against process metadata across polls:

- **Reject stateful regex flags.** `g` and `y` cause `RegExp.prototype.test()` to advance `lastIndex`, producing non-deterministic results across calls with the same compiled regex. Whitelist only stateless flags (`i`, `s`, `m`, `u`, `v`).
- **Reject empty matchers at the schema level.** `''.includes('')` is `true` and `new RegExp('')` matches everything — an empty matcher silently turns an opt-in feature into a kill-everything (or match-everything) rule. Enforce `min(1)` in the Zod schema, not at evaluation time.
- **Compile regexes once at normalization time**, not per-tick. Surface compilation errors with rule context (description/label) so misconfiguration is debuggable.

## Designing for testability

Modules that interact with the OS (process listing, signals, timers) should accept their OS dependencies as injected functions, not import them directly:

```ts
startSubprocessMonitor({
  processLister, // () => Promise<ProcessInfo[]>
  killFn,        // (pid, signal) => void
  now,           // () => number
  setIntervalFn,
  setTimeoutFn,
  ...
});
```

This makes every escalation-timing scenario unit-testable with fake timers and a scripted process list — no real subprocesses, no real signals. Real-process integration is a single thin platform-gated test, not the whole suite. Apply this pattern to any new OS-interaction module.
