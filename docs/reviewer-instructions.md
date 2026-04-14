- When duplicate logic appears across multiple functions (e.g., branch setup in both `prepareExistingWorkspace` and `createWorkspace`), verify that error handling and edge cases are covered consistently in all locations — it's common for fixes applied to one copy to be missed in the other.
- When reviewing Svelte code, be sure to load the svelte-core-bestpractices skill.
- When reviewing SvelteKit code, you should flag API +server.ts endpoints as anti-patterns, unless you need SSE event streaming. SvelteKit
  remote functions using `form`, `command`, and `query` are preferred otherwise.
- Svelte `$derived` expressions ARE writable and it is the correct pattern to use them that way. The expression will automatically reevaluate when things change, so you can
  use this for local state that should be reset on navigation, without needing to use `$effect`. If the expression does not actually depend on the props (e.g. a dialogOpen boolean), use `afterNavigate` to reset.
- Calls to SvelteKit remote query functions should almost always use the `let data = $derived(await query(...))` pattern instead, and let errors bubble up through the SvelteKit error boundaries. If you need custom error handling then skip the `await` which gives you the object with `current`, `error` and similar. NEVER use $effect for this.
- Svelte $effect should almost never be used. Prefer event callbacks, afterNavigate, actions/attachments, or mutable derived when possible.
