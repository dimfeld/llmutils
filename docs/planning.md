- When writing SvelteKit code, never use API +server.ts endpoints unless you need SSE event streaming. SvelteKit
  remote functions using `form`, `command`, and `query` are ALWAYS preferred otherwise.
