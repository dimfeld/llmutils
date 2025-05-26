---
description: Logging
globs:
trigger: always_on
---

When writing to console, use the functions in 'src/logging.ts' instead. They can be imported like this and used the same as the console functions.

`debugLog` can be used for debug-only logs.

`import { log, warn, error, debugLog } from './logging.ts';`
