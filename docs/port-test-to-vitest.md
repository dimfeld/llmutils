1. Find a test that uses 'bun:test'
2. Update the import to use 'vitest' instead, and add a `vi` import (even if not used initially)
3. Uses of `mock` to create stub functions should be updated to use `vi.fn()`
4. ModuleMocker was specific to bun and does not work in vitest. Instead of ModuleMocker, use `vi.mock()` at the module level (before imports)
5. For complex mocking scenarios:
   - Declare mock variables with `let` at the top level
   - Use `vi.mock()` with factory functions that return `vi.fn()`
   - Import the mocked modules after the vi.mock() calls
   - Cast the imported functions to mocks in setup code
   - Set up default mock implementations in beforeEach blocks
6. Run the converted test with `bun run test path/to/test.ts` to verify it works
7. If the test doesn't use mocking features, the conversion is typically just changing the import statement
8. Common vitest mocking patterns:
   - `vi.mock('module', () => ({ fn: vi.fn() }))` for simple mocks
   - Import after mocking, then cast to mock types
   - Use beforeEach to set up default mock behavior
9. If you need a properly-typed version of a mocked function, use `let mockFn = vi.mocked(fn)`;
10. Additional learnings from conversions:
    - Keep using Bun runtime features like `Bun.write()` since we're still using Bun as the package manager and runtime
    - Replace `toEndWith()` assertions with regex patterns like `toMatch(/-$/)`
    - For module mocks like `node:os`, provide default implementations in the vi.mock() factory
    - Use `vi.mocked()` to get properly typed mock instances
    - Use `vi.clearAllMocks()` instead of ModuleMocker's clear() method
    - Mock setup should be done in beforeEach, with mock configuration applied to the vi.mocked() instances
    - Use `importOriginal` to fill in exports from modules that are not mocked.
11. Important vitest hoisting rules:
    - `vi.mock()` calls are hoisted to the top of the file, so variables referenced inside factory functions must be defined inline
    - Don't reference external variables in vi.mock() factories - define them inline instead
12. Complex test conversion patterns:
    - Replace ModuleMocker with vi.mock() at module level
    - Remove afterAll() moduleMocker.clear() calls - use vi.clearAllMocks() in afterEach instead
    - Import individual mock functions and use vi.mocked() to get properly typed instances
    - Set up mock implementations in beforeEach using vi.mocked() instances

Note that we are not moving away from bun, just away from bun:test.
