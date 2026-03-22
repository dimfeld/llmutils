- When reviewing Svelte code, be sure to load the svelte-core-bestpractices skill.
- When reviewing SvelteKit code, you should flag API +server.ts endpoints as anti-patterns, unless you need SSE event streaming. SvelteKit
  remote functions using `form`, `command`, and `query` are preferred otherwise.
- Svelte `$derived` expressions ARE writable and it is the correct pattern to use them that way. The expression will automatically reevaluate when things change, so you can
  use this for local state that should be reset on navigation, without needing to use `$effect`. If the expression does not actually depend on the props (e.g. a dialogOpen boolean), use `afterNavigate` to reset.
- Svelte $effect should almost never be used. Prefer event callbacks, afterNavigate, actions/attachments, or mutable derived when possible.
