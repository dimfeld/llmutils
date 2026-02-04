---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: make tim publishable
goal: ""
id: 157
uuid: 335bee65-d72f-48f0-a001-6644b66d3c17
generatedBy: agent
status: pending
priority: medium
planGeneratedAt: 2026-01-08T22:58:34.813Z
promptsGeneratedAt: 2026-01-08T22:58:34.813Z
createdAt: 2026-01-02T16:39:06.907Z
updatedAt: 2026-01-08T22:58:34.813Z
tasks:
  - title: Add version field to root package.json
    done: false
    description: Add a version field to the root package.json to serve as the source
      of truth for the tim version. Start with version 0.1.0.
  - title: Create MIT LICENSE file
    done: false
    description: Create a LICENSE file in the repository root with the MIT license
      text, including the correct year and author name.
  - title: Update build.ts to generate dist/package.json
    done: false
    description: "Modify build.ts to generate a dist/package.json during the build
      process. Read version from root package.json. Include: name
      (@dimfeld/tim), bin entry, files array, repository info, license,
      engines requirement for Bun."
  - title: Update build.ts to copy README and LICENSE to dist
    done: false
    description: Add logic to build.ts to copy README.md and LICENSE to the dist
      directory during the build process.
  - title: Add publish scripts to root package.json
    done: false
    description: "Add scripts for publishing: publish:tim that runs build then
      publishes from dist directory. Consider adding a prepublishOnly script
      that verifies all required files exist."
  - title: Update README with npm installation instructions
    done: false
    description: Add a section to README.md explaining how to install via npm (npm
      install -g @dimfeld/tim or bun add -g @dimfeld/tim). Include note
      that Bun is required as the runtime.
  - title: Test publish workflow with npm pack
    done: false
    description: "Run bun run build, then npm pack in dist directory to create a
      tarball. Install the tarball globally and verify tim command works
      correctly. Test key features: list, show, and Claude Code executor."
tags: []
---

For this we want to publish the built version of the tim.js script since it runs faster.

## Research

### Overview

This plan involves making `tim` publishable as an npm package so users can install it via `npm install -g tim` (or similar). Currently, installation requires cloning the repository and running `pnpm add -g file://$(pwd)`, which is cumbersome for end users.

### Key Findings

#### Current Build Architecture

1. **Build Script (`build.ts`)**: Located at the repository root, it uses Bun's bundler to create:
   - `dist/tim.js` (~8.9MB minified) - The main CLI bundle
   - `dist/claude_code/permissions_mcp.js` (~1.8MB) - Helper MCP server for Claude Code executor permissions
   - WASM files copied from node_modules to `dist/` for tree-sitter support

2. **Entry Points**: The build creates self-contained bundles with `#!/usr/bin/env bun` shebang, targeting the Bun runtime.

3. **WASM Files Required**: The following tree-sitter WASM files are copied to dist:
   - `tree-sitter.wasm`
   - `tree-sitter-python.wasm`
   - `tree-sitter-rust.wasm`
   - `tree-sitter-typescript.wasm`
   - `tree-sitter-tsx.wasm`
   - `tree-sitter-javascript.wasm`
   - `tree-sitter-svelte.wasm`

#### Current Package Configuration

The current `package.json` has:
- `"private": true` - Prevents npm publishing
- No `version` field (required for npm)
- `bin` entries pointing to TypeScript source files (`.ts`), not the built JavaScript
- `name: "llmutils"` - Not the desired package name for publishing

#### Runtime Dependencies

The bundled code is self-contained except for:
1. **Bun runtime** - Required due to `#!/usr/bin/env bun` shebang
2. **Dynamic imports** - Some modules use `import.meta.require()` which is Bun-specific
3. **WASM files** - Must be co-located with the bundle for tree-sitter

#### File Resolution in Built Code

The `permissions_mcp` file is resolved at runtime using:
```typescript
let permissionsMcpPath = path.resolve(import.meta.dir, './claude_code/permissions_mcp.ts');
if (!(await Bun.file(permissionsMcpPath).exists())) {
  permissionsMcpPath = path.resolve(import.meta.dir, './claude_code/permissions_mcp.js');
}
```

In the bundled output, `import.meta.dir` correctly resolves to the bundle's directory, so this fallback pattern works correctly.

#### External Dependencies

The build script marks these as external (not bundled):
- `effect`
- `@valibot/to-json-schema`
- `sury`

These would need to be declared as dependencies if they're actually used at runtime.

### Architectural Considerations

1. **Separate Package vs. Modified Monorepo**: Two approaches are possible:
   - Create a separate `dist/package.json` for publishing (recommended)
   - Modify the root package.json (would require careful handling of source vs. built files)

2. **Package Name**: Options include:
   - `tim` (short, memorable, may be taken)
   - `@dimfeld/tim` (scoped, guaranteed available)

3. **Files to Include in Package**:
   - `dist/tim.js`
   - `dist/claude_code/permissions_mcp.js`
   - All WASM files in `dist/`
   - `README.md`
   - `LICENSE` (if exists)

4. **Version Management**: Need to decide on versioning strategy (manual vs. automated)

### Dependencies & Constraints

- **Bun Required**: The built script uses Bun-specific APIs and the shebang requires Bun
- **Node.js Compatibility**: Not compatible with Node.js due to Bun-specific features
- **External Dependencies**: Verified that external dependencies (`effect`, `@valibot/to-json-schema`, `sury`) are NOT used in tim code, so no additional dependencies needed

### Decisions Made

Based on discussion with the user:

1. **Package Name**: `@dimfeld/tim` (scoped package)
2. **Version Management**: Version from root `package.json`
3. **License**: MIT (need to create LICENSE file)
4. **Source Maps**: Include source maps in the published package
5. **README**: Include full README.md in the published package

## Implementation Guide

### Expected Behavior/Outcome

After implementation, users should be able to:
```bash
# Install globally
npm install -g @dimfeld/tim
# Or with bun
bun add -g @dimfeld/tim

# Run tim
tim --help
tim generate --issue 123 -- src/**/*.ts
```

### Acceptance Criteria

- [ ] Running `npm publish` from dist/ successfully publishes the package
- [ ] Users can install via `npm install -g @dimfeld/tim`
- [ ] `tim` command works after installation
- [ ] All WASM files are included and accessible at runtime
- [ ] `permissions_mcp.js` is found correctly by the Claude Code executor
- [ ] Build script generates a complete publishable package
- [ ] Version is read from root package.json and written to dist/package.json
- [ ] LICENSE file is created and included in the package

### Implementation Steps

#### Step 1: Create Package Configuration for Publishing

Create a new file `dist-package.json` (or modify build script to generate `dist/package.json`) with:

```json
{
  "name": "@dimfeld/tim",
  "version": "0.1.0",
  "description": "AI-powered project planning and execution system for software development",
  "type": "module",
  "bin": {
    "tim": "./tim.js"
  },
  "files": [
    "tim.js",
    "tim.js.map",
    "claude_code/",
    "*.wasm"
  ],
  "keywords": ["ai", "llm", "project-planning", "claude", "development"],
  "repository": {
    "type": "git",
    "url": "https://github.com/dimfeld/llmutils.git"
  },
  "author": "Daniel Imfeld",
  "license": "MIT",
  "engines": {
    "bun": ">=1.0.0"
  }
}
```

#### Step 2: Update Build Script

Modify `build.ts` to:
1. Generate `dist/package.json` from a template
2. Copy README.md to dist/
3. Optionally copy LICENSE if it exists
4. Add a version sync mechanism (read from a source, write to dist/package.json)

The build script already handles WASM file copying, so that part is covered.

#### Step 3: Add Version Management

Options:
1. **Manual**: Keep version in a dedicated file (e.g., `version.ts`) and read during build
2. **Package.json based**: Read from root package.json and use for dist
3. **Git tags**: Derive version from git tags during build/publish

#### Step 4: Add Publish Scripts

Add to root `package.json`:
```json
{
  "scripts": {
    "prepublish": "bun run build",
    "publish:tim": "cd dist && npm publish"
  }
}
```

Or create a dedicated publish script that:
1. Runs the build
2. Verifies all required files exist
3. Runs `npm publish` from the dist directory

#### Step 5: Verify External Dependencies

Check if the externalized dependencies (`effect`, `@valibot/to-json-schema`, `sury`) are actually used at runtime. If so:
1. Add them to dist/package.json dependencies
2. Or bundle them instead (remove from external list)

#### Step 6: Test the Published Package

Before actual publishing:
1. Run `npm pack` in dist/ to create a tarball
2. Install the tarball globally: `npm install -g ./tim-0.1.0.tgz`
3. Test all major features work correctly

#### Step 7: Documentation Updates

Update README.md with:
1. Installation instructions for npm users
2. Bun requirement notice
3. Changelog or version history section

### Manual Testing Steps

1. Run `bun run build` to generate the dist output
2. Verify dist/ contains: `tim.js`, `claude_code/permissions_mcp.js`, all WASM files
3. Run `npm pack` in dist/ directory
4. Install the generated tarball: `bun add -g ./tim-*.tgz`
5. Verify `tim --version` works
6. Test `tim list`, `tim show --next`, and other commands
7. Test with a sample plan execution to verify WASM files work
8. Test Claude Code executor to verify permissions_mcp.js is found

### Potential Gotchas

1. **WASM File Paths**: Ensure WASM files are resolved relative to the bundle, not the working directory
2. **Permissions MCP Path**: The fallback logic in claude_code.ts handles .ts vs .js, should work correctly
3. **npm vs bun**: Users need Bun installed; clear error if Node.js is used instead
4. **Package Name Availability**: Check if `tim` is available on npm before choosing the name
5. **Source Maps**: Decide whether to include `.map` files in the published package (helps debugging but increases size)
