- When writing Svelte code, be sure to load the svelte-core-bestpractices skill.
- Svelte `$derived` expressions ARE writable. The expression will automatically reevaluate when things change, so you can
  use this for local state that should be reset on navigation, without needing to use `$effect`. Prefer afterNavigate though, checking if the pathname changed, if you are just resetting local state on navigation that isn't actually derived from the props.
- Calls to SvelteKit remote query functions should almost always use the `let data = $derived(await query(...))` pattern instead, and let errors bubble up through the SvelteKit error boundaries. If you need custom error handling then skip the `await` which gives you the object with `current`, `error` and similar. NEVER use $effect for this.
- Svelte $effect should almost never be used. Prefer event callbacks, afterNavigate, actions/attachments, or mutable
  derived when possible.
- Zod recursive schemas (e.g., for tree-structured data like `IssueWithComments`) need `z.lazy()` with an explicit `z.ZodType<YourType>` annotation on the base reference. Without the type annotation, TypeScript cannot infer the recursive type and will error.
