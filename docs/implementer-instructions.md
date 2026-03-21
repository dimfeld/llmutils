- When writing Svelte code, be sure to load the svelte-core-bestpractices skill.
- Svelte `$derived` expressions ARE writable. The expression will automatically reevaluate when things change, so you can
  use this for local state that should be reset on navigation, without needing to use `$effect`.
- Svelte $effect should almost never be used. Prefer event callbacks, afterNavigate, actions/attachments, or mutable
  derived when possible.
