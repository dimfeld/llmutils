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

## Targeted executor signals

The session process registry is the authoritative source for the process tree. OS inspection is a
safety check only. The web server does not accept a PID and does not signal an arbitrary process.
Each `tim` owner keeps a direct-child executor handle and the metadata captured when that child
starts.

Before sending `SIGTERM`, the owner takes a fresh process list and requires all four identity
checks to pass:

1. The current PID equals the tracked PID.
2. The current PPID equals the owner process PID.
3. The full current command equals the tracked command.
4. The current `lstart` value equals the tracked opaque start identity.

The check must use the full command and the unmodified `lstart` value. Do not parse or normalize
`lstart`. A PID match without the other three values is not safe to signal.

Keep the identity command separate from the displayed command. The owner compares the full command
that it captured from the process list, not the command that it reported to the registry or the
tunnel. Command metadata sent to the tree is length-bounded and can be truncated, so it is display
data only. Do not compare a truncated, expected, or user-supplied command value.

If the PID is absent, treat the executor as already exited and remove its direct-child capability.
If the owner never captured process-list details for the child, the state is unknown and it must
not signal. If `ps` fails or its output cannot be trusted, return an unknown process state and do not signal.
Keep the tracked child so a later request can retry after a transient listing failure. If any
identity value differs, mark the target stale and do not signal it. If `kill()` returns `ESRCH`,
the process exited during the race and the stop is already complete. Report other signal errors,
but keep the live handle retryable.

This owner check applies to root-owned executors and to nested executors after a request reaches
their owning `tim` process through the tunnel. The opaque session process ID selects the owner;
the OS PID is never the UI control key.

`AgentManager` stops agents through provider-neutral lifecycle controls only
(see [agent-manager.md](agent-manager.md)). It never holds or signals a PID, so
a provider adapter that owns a real child process must run these identity
checks itself behind `requestForcedShutdown()`. A logical provider without an
OS process implements the same control without any signal.

## Explicit session process tracking

Do not use `ps` as the source of the session process tree. A `SessionProcessRegistry` receives
explicit registration, update, exit, and removal events. It stores opaque node IDs, parent and
owner relationships, lifecycle state, and optional OS identity metadata. The registry is
ephemeral and exists only for the live session.

The root session routes a targeted executor request to the tunnel channel bound to the executor's
`tim` owner. The tunnel server stores only connected channel capabilities; it must not keep a
second process map or expose a PID-based signal operation. The owner keeps a direct-child handle
and performs the fresh PID/PPID/command/`lstart` checks above. If tracking is inactive, lifecycle
events are safe no-ops and existing CLI execution continues without process-control behavior.

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
