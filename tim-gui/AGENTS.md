## Build and Test

- `./scripts/restart.sh` (rebuild signed Debug + restart)
- `./scripts/build.sh` (plain build without running)
- `./scripts/test.sh` (run unit tests via xcodebuild)
- `./scripts/lint.sh` (SwiftFormat + SwiftLint)

## Documentation

Look in the `docs` directory for guidance on writing Swift and using SwiftUI.

## SwiftUI Conventions

- **Use `.opacity()` instead of conditional rendering for fixed-size elements**: When toggling visibility of small fixed-size elements (e.g., indicator dots), use `.opacity(condition ? 1 : 0)` rather than `if condition { Circle() }`. Conditional rendering causes layout shifts as SwiftUI adds/removes the element from the view hierarchy, while opacity reserves the space and avoids jank.
