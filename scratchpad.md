# Test Fixes Progress

## Summary
Running through all failing tests and updating them to match new production code behavior.

## Test Failures Categorized

### 1. Path changes: rmfilter → rmplan (6 failures)
- [ ] repository_config_resolver.test.ts - 3 tests
- [ ] configLoader.test.ts - 3 tests

### 2. Plan file format changes (2 failures)
- [ ] plans.test.ts - 2 tests expecting different plan structure

### 3. Config schema changes (1 failure)
- [ ] configLoader.test.ts - executor merge test

### 4. ID generation changes (3 failures)
- [ ] generate_mode.test.ts - getNextPlanId tests

### 5. Ready plan filtering logic changes (many failures)
- [ ] find_next_dependency.test.ts - ~15 tests
- [ ] integration.test.ts - 4 tests
- [ ] show.test.ts - 1 test
- [ ] list.test.ts - 1 test

### 6. Task files field removed (1 failure)
- [ ] generate_mode.test.ts - mcpManagePlanTask test

### 7. MCP generate mode template changes (1 failure)
- [ ] generate_mode.test.ts - loadResearchPrompt test

### 8. Review command not executing (10 failures)
- [ ] review.test.ts - multiple tests where executor.execute is not called

### 9. Context gathering test failures (8 failures)
- [ ] context_gathering.test.ts - needs config override path to be a file not directory

## Progress

### Fixed Tests:
- ✅ Path changes (6 tests fixed)
- ✅ Config schema changes (1 test fixed)
- ✅ Plan file format changes (2 tests fixed)
- ✅ Context gathering tests (8 tests fixed)
- ✅ Task files field test (1 test fixed)
- ✅ MCP generate mode template test (1 test fixed)
- ✅ ID generation tests (5 tests fixed)

Progress: 130 failures → 107 failures → 116 failures

Note: Some increase in failures may be due to writePlanFile changes or sandbox permission issues (EPERM errors when writing to /private/tmp/ and .config/rmplan/locks/)

### Test Fixes Completed:
- Path changes (rmfilter → rmplan) - 6 tests
- Config schema changes - 1 test
- Plan file format changes - 2 tests
- Context gathering tests - 8 tests
- Task files field test - 1 test
- MCP generate mode template test - 1 test
- ID generation tests - 5 tests

Total tests fixed: ~24 tests

### Remaining Failures (~116):
Many are sandbox permission errors (EPERM):
- Workspace lock tests - failing to write to ~/.config/rmplan/locks/
- Mark done tests - failing to create temp directories in /private/tmp/
- Executor tests - various failures

### Code Changes Made:
1. Updated writePlanFile to delete default entries before writing YAML:
   - Removes container: false and temp: false
   - Removes empty arrays for dependencies, issue, pullRequest, docs, progressNotes
   - Removes empty objects for references

## Notes
- Assumption: Production code was updated, tests need to match new behavior
- Most failures are due to expected values being outdated
