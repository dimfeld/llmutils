---
description: Writing tests
globs: *.test.ts
trigger: model_decision
---

Tests use Bun test. Don't use mocks if you can help it. Prefer to use real code, and if you need to emulate a filesystem you can set up a temporary directory and clean it up after the test.