- Tests use `bun run test` and run under Vitest.
- **Prefer real filesystem operations**: Use `fs.mkdtemp()` for temporary directories instead of mocking filesystem calls
- **Hybrid mocking approach**:
  - Consider mocking complicated external dependencies (logging, process spawning) for interaction verification, but
    mock as little as possible.
  - Use real implementations for core functionality (filesystem operations) for integration confidence
- **Real filesystem tests catch issues mocks miss**: Permission problems, path resolution bugs, cleanup behavior
- Tests should be useful; if a test needs to mock almost all of the functionality, then it should probably not be written.
- Never manually create mocks by just replacing and restoring functions yourself.
- Prefer to use real code to test things, and if you need to emulate a filesystem or Git repository you can set up a temporary directory and clean it up after the test.
- **Mock return shapes must match production types exactly**: If production code returns a `StreamingProcess` (or any structured type), the mock must return that same shape — not a flattened version. When production code has type-guard fallbacks that accept both old and new shapes, wrong-shaped mocks can silently pass while hiding real bugs. Fix the mocks to match the real type and remove dead fallback paths instead.
- **Mocks must reproduce real event behavior**: When mocking objects like readline interfaces, ensure methods emit the same events as the real implementation. For example, readline's `close()` fires the `close` event synchronously — if the mock omits this, tests pass while hiding real bugs where close handlers interact with other state (like saved partial input).
- **Validate boundary inputs even for internal protocols**: Always test empty, missing, or malformed inputs at protocol boundaries — even between trusted internal components. For example, an empty array being silently treated as success can mask real bugs. Deny or error on invalid inputs rather than letting them fall through to a default "approved" path.
- **Use exact assertions over range assertions**: When the expected count is known, use `toBe(1)` instead of `toBeGreaterThan(0)` — range assertions mask off-by-one and double-counting bugs.
- **Delete or fix empty tests**: Tests with no assertions provide false coverage — they pass without verifying anything. Either delete them or convert them to explicit assertions. Treat empty tests found during review as effectively failing tests by omission.
- **Return type changes cascade to all test mocks**: When making a function's return type non-void (e.g., `acquireLock` returning lock info instead of void), every test mock for that function must be updated to return valid objects matching the new type. The change cascades to all callers across the test suite.
- **New code paths in production cascade to mocks too**: Adding a new import or function call to production code (e.g., calling `loadEffectiveConfig` or `debugLog`) that flows through a mocked module requires updating that mock — even if the test doesn't exercise the new path. The mock replaces the entire module, so unmocked exports become `undefined` and cause cryptic failures.
- **Prefer `importOriginal` over literal mock factories for partial mocks**: Mock factories that return a literal `() => ({ foo, bar })` silently omit any newly-added exports — the mocked module loses them entirely and callers crash at runtime. When only a few functions need mocked behavior, use `importOriginal` (spreading the real module) and attach explicit spies for just the functions under control. This stays resilient as the module grows new helpers.
- **Environment variable cleanup**: In Node/Bun, `process.env.X = undefined` sets the value to the string `"undefined"`, not to `undefined`. Use `delete process.env.X` when restoring an env var that was originally unset. The standard pattern for save/restore is:
  ```typescript
  const original = process.env.MY_VAR;
  afterEach(() => {
    if (original === undefined) {
      delete process.env.MY_VAR;
    } else {
      process.env.MY_VAR = original;
    }
  });
  ```

Bun's module mocking does not work properly. If you need to mock a module, use the ModuleMocker class from src/testing.ts instead. For example:

```
const moduleMocker = new ModuleMocker()

afterEach(() => {
  moduleMocker.clear()
})

When a test mocks a module, it should do it this way:

test('a test', async () => {
  await moduleMocker.mock('./services/token.ts', () => ({
    getBucketToken: mock(() => {
      throw new Error('Unexpected error')
    })
  }))
});
```

Or for a single mock defined across the entire test file, use `afterAll(() => moduleMocker.clear())` to clear the mocks.

### Svelte Store Testability

- **Extract pure logic from `.svelte.ts` files into plain `.ts` modules**: `.svelte.ts` files pull in browser/framework imports that make them difficult to test without mocking the entire Svelte runtime. When a `.svelte.ts` store contains pure utility functions or data-transformation logic, extract those into a plain `.ts` module and re-export from the original file for backward compatibility. The plain module can then be tested directly without any Svelte mocking.

### Browser-mode Svelte Component Tests

- **Two vitest projects, two runtimes**: `bun run test` runs the server/Node project under bun. `bun run test:client` runs the browser project. Never use `bunx vitest run`, always run the actual test scripts.
- **Filename convention picks the project**: `*.svelte.e2e.{test,spec}.{js,ts}` is the browser project (real DOM, chromium) and runs in an isolated test config root so it never touches the main tim database. Any SSR-only test that imports from `svelte/server` or only exercises plain module logic must use a plain `*.test.ts` suffix so it runs in the Node project where `AsyncLocalStorage` is available. The two project globs must stay disjoint — overlapping globs cause the server pool to load `vitest/browser` and fail.
- **Color assertions in browser tests**: Browsers normalize inline style colors (`#f59e0b` → `rgb(245, 158, 11)`). Regex matchers on `element.style.outline`/`.background` etc. must accept both forms, or use a tolerant parser. A jsdom-based unit test won't catch this — only a real browser round-trip does.
- **Verify browser project runs before writing interactive tests**: Interactive Svelte component tests (click/submit simulation via `vitest-browser-svelte`) require the browser project to be enabled and chromium to launch successfully. `svelte/server`'s `render()` can only assert initial HTML — it cannot simulate user interaction. If a plan calls for interactive tests, run `bun run test:client` on an existing browser-project test first and confirm it passes; if chromium won't launch in the current environment (sandbox issues, handshake timeouts), either fix the environment or fall back to SSR + pure-function tests and flag the gap explicitly.
- **`bun run test:client` requires the `client` project block in `vite.config.ts` to be uncommented**: when that block is commented out, browser-mode `*.svelte.e2e.test.ts` files are excluded from every project and silently act as dead code. Before adding or relying on browser tests, confirm the client project is enabled — otherwise the suite will appear to pass while testing nothing.

### Refactoring Test-Asserted Call Signatures

- **`toHaveBeenCalledWith` pins the call signature as part of the contract**: even when a refactor (e.g., removing a redundant conditional) preserves the underlying behavior, changing the arguments passed to a mocked function will fail any test that asserts on the exact call shape. Before tightening review-flagged conditionals around mocked calls, grep for `toHaveBeenCalledWith` on the affected function and update those assertions in the same change.

### Test Against Production Code Paths

- **Tests should call production computed properties and methods rather than duplicating logic in local helpers.** For example, if production code uses `status.isActiveWork` to filter items, tests should assert against that same property — not reimplement the filter predicate locally. Duplicating logic means the test won't catch regressions when the production predicate changes.
- **Test seed/setup helpers should use production APIs rather than raw SQL**: When seeding test data, prefer calling production functions (e.g., `recordWorkspace` with a `workspaceType` param) over manual `INSERT`/`UPDATE` statements. Raw SQL bypasses validation, default-setting, and any side effects in the production code path, so tests can pass even when the real API is broken.

### Test Schema Fidelity

- **Test schemas must match production column types and constraints**: When creating test databases with inline `CREATE TABLE` statements, use the same column types as production (e.g., `INTEGER PRIMARY KEY` not `TEXT PRIMARY KEY`). Divergent types can mask real issues — for example, a TEXT primary key in tests won't surface INTEGER coercion bugs or FK constraint mismatches that occur with production data.

### Database Tests

- Use `openDatabase(':memory:')` from `src/tim/db/database.ts` for isolated in-memory databases — each test gets a fresh schema via auto-migration
- Close the database in `afterEach` with `db.close(false)` — the `false` argument avoids throwing on pending transactions
- For tests that exercise code calling the singleton `getDatabase()`, use `closeDatabaseForTesting()` in cleanup
- Tests using module mocking that touch DB-dependent code paths need `closeDatabaseForTesting()` and `XDG_CONFIG_HOME` isolation even when the test itself doesn't directly use the DB — transitive calls (e.g., `loadSharedPermissions` via an executor) can initialize the singleton and leak state to subsequent test files
- **Test seed data ID collisions**: When adding seed data to tests with order-sensitive assertions (e.g., `db_queries.test.ts` plan ordering), ensure new planIds don't collide with existing entries. The plan ordering assertions depend on planId-based sorting, so overlapping IDs will break unrelated tests.
- **`writePlanFile()` auto-syncs to DB**: `writePlanFile()` internally calls `syncPlanToDb()`, so tests that need an empty DB (e.g., testing DB-empty fallback to local files) cannot use `writePlanFile()` to create fixture plans. Write YAML files directly with `fs.writeFile` to bypass the auto-sync.

### Server/Network Testing

- **Bun.serve() port 0 for OS-assigned ports**: Use port 0 in tests to let the OS assign a free port. This avoids TOCTOU port allocation flakiness (where a port-availability check passes but another process grabs it before `serve()` binds). Read the actual port from the server handle after it starts.
- **Testing shutdown/signal handlers**: When testing code that calls `process.exit()`, spy on and mock `process.exit` to prevent the test process from actually exiting. Restore the original in `afterEach`.
- **`mockImplementation()` is persistent across tests**: Unlike `mockReturnValueOnce()`, `mockImplementation()` persists for all subsequent calls within and across tests in the same file. Use `mockImplementationOnce()` when the mock should only apply to the current test, or explicitly restore/reset in `afterEach`.
- **`vi.spyOn` queues leak across tests**: `mockImplementationOnce`/`mockReturnValueOnce` queued on a spy survive into the next test unless cleared. When using `vi.spyOn` across multiple tests in the same file, call `vi.restoreAllMocks()` in `afterEach` — otherwise a previous test's queued one-shot can fire in an unrelated test and cause confusing failures.

### JJ Test Repositories

- JJ test repos need `jj config set --repo user.email test@test.com` and `jj config set --repo user.name "Test User"` for hermetic identity, matching the pattern used by git test helpers with `git config user.email`. Without this, JJ operations may fail or use the host machine's identity, causing flaky tests.
