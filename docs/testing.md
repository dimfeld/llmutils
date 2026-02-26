- Tests use Bun test.
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

### Test Against Production Code Paths

- **Tests should call production computed properties and methods rather than duplicating logic in local helpers.** For example, if production code uses `status.isActiveWork` to filter items, tests should assert against that same property — not reimplement the filter predicate locally. Duplicating logic means the test won't catch regressions when the production predicate changes.

### Test Schema Fidelity

- **Test schemas must match production column types and constraints**: When creating test databases with inline `CREATE TABLE` statements, use the same column types as production (e.g., `INTEGER PRIMARY KEY` not `TEXT PRIMARY KEY`). Divergent types can mask real issues — for example, a TEXT primary key in tests won't surface INTEGER coercion bugs or FK constraint mismatches that occur with production data.

### Database Tests

- Use `openDatabase(':memory:')` from `src/tim/db/database.ts` for isolated in-memory databases — each test gets a fresh schema via auto-migration
- Close the database in `afterEach` with `db.close(false)` — the `false` argument avoids throwing on pending transactions
- For tests that exercise code calling the singleton `getDatabase()`, use `closeDatabaseForTesting()` in cleanup
- Tests using module mocking that touch DB-dependent code paths need `closeDatabaseForTesting()` and `XDG_CONFIG_HOME` isolation even when the test itself doesn't directly use the DB — transitive calls (e.g., `loadSharedPermissions` via an executor) can initialize the singleton and leak state to subsequent test files
