# Parent-Child Plan Relationships in tim

This guide provides a comprehensive overview of working with parent-child relationships in tim, including how to create hierarchical plans, understand the automatic maintenance features, and follow best practices for organizing multi-phase projects.

## Overview

Parent-child relationships in tim allow you to organize complex projects into manageable hierarchies. These relationships are **bidirectional**, meaning that when a child plan references a parent, the parent plan automatically includes that child in its dependencies array. This ensures consistency in the dependency graph and prevents orphaned child plans.

## Key Features

### Bidirectional Consistency

- When you set a parent on a child plan, the parent is automatically updated to include the child in its dependencies
- When you change a child's parent, both the old and new parent plans are updated appropriately
- When you remove a parent relationship, the child is automatically removed from the parent's dependencies

### Automatic Maintenance

All tim commands work together to maintain consistency:

- **`add` command**: When creating plans with `--parent`, automatically updates the parent's dependencies
- **`set` command**: When modifying parent relationships, updates all affected plans
- **`validate` command**: Detects and fixes any inconsistencies in existing plan relationships

### Automatic Parent Completion

When all child plans of a parent reach a terminal state (`done` or `cancelled`), the parent plan is automatically marked as `done`. This applies consistently across both the CLI (`tim done`) and agent execution paths. A cancelled parent is preserved — completing the last child will not overwrite a parent that was explicitly cancelled.

**Implementation note**: Parent completion checks must run _after_ writing the child's updated status to the plan file. If the check runs before the write, it reads stale data and may not detect that all children are now complete.

### Circular Dependency Prevention

The system prevents circular dependencies by checking the entire dependency chain before making any changes.

## Creating Parent-Child Relationships

### Using the Add Command

When creating new plans, you can establish parent-child relationships immediately:

```bash
# Create a parent plan
tim add "User Authentication System" --output tasks/auth-system.yml

# Create child plans that reference the parent
tim add "Database Schema" --parent auth-system --output tasks/db-schema.yml
tim add "API Endpoints" --parent auth-system --depends-on db-schema --output tasks/api-endpoints.yml
tim add "Frontend Components" --parent auth-system --depends-on api-endpoints --output tasks/frontend.yml
```

In this example:

- `auth-system.yml` becomes the parent plan
- All child plans (`db-schema.yml`, `api-endpoints.yml`, `frontend.yml`) will automatically be added to the parent's dependencies array
- Child plans can have their own dependencies (like `api-endpoints` depending on `db-schema`)

### Using the Set Command

You can establish or modify parent-child relationships for existing plans:

```bash
# Set a parent for an existing plan
tim set existing-plan.yml --parent parent-plan-id

# Change a plan's parent (updates both old and new parents)
tim set child-plan.yml --parent new-parent-id

# Remove a parent relationship
tim set child-plan.yml --no-parent
```

## Plan File Structure

### Child Plan Structure

```yaml
id: child-plan-123
title: 'Database Schema Setup'
parent: auth-system-456 # References parent plan ID
dependencies: [] # Child's own dependencies
status: pending
priority: high
tasks:
  - title: 'Create user tables'
    # ... task details
```

### Parent Plan Structure

```yaml
id: auth-system-456
title: 'User Authentication System'
dependencies: [child-plan-123, another-child-789] # Automatically maintained
status: pending
priority: high
tasks:
  - title: 'Coordinate authentication implementation'
    # ... task details
```

## Working with Multi-Level Hierarchies

tim supports complex, multi-level hierarchies:

```
Project Root (ID: 100)
├── Phase 1: Foundation (ID: 101)
│   ├── Database Schema (ID: 111)
│   └── Core API (ID: 112)
├── Phase 2: Features (ID: 102)
│   ├── User Management (ID: 121)
│   └── Authentication (ID: 122)
└── Phase 3: Integration (ID: 103)
    ├── Frontend Integration (ID: 131)
    └── Testing Suite (ID: 132)
```

### Creating Multi-Level Hierarchies

```bash
# Create the root project
tim add "Complete Authentication System" --output tasks/auth-root.yml

# Create phase plans
tim add "Foundation Phase" --parent auth-root --output tasks/phase-1.yml
tim add "Features Phase" --parent auth-root --depends-on phase-1 --output tasks/phase-2.yml
tim add "Integration Phase" --parent auth-root --depends-on phase-2 --output tasks/phase-3.yml

# Create sub-tasks for each phase
tim add "Database Schema" --parent phase-1 --output tasks/db-schema.yml
tim add "Core API" --parent phase-1 --depends-on db-schema --output tasks/core-api.yml

tim add "User Management" --parent phase-2 --depends-on core-api --output tasks/user-mgmt.yml
tim add "Authentication" --parent phase-2 --depends-on user-mgmt --output tasks/auth-impl.yml
```

## Validation and Auto-Fixing

### Running Validation

The `validate` command ensures your plan relationships remain consistent:

```bash
# Validate all plans
tim validate

# Validate specific plans
tim validate tasks/*.yml

# Validate with detailed output
tim validate --verbose

# Check without auto-fixing
tim validate --no-fix
```

### What Gets Validated

1. **Schema Compliance**: Ensures all plan files follow the correct YAML structure
2. **Parent-Child Consistency**: Verifies that every child-parent relationship is bidirectional
3. **Circular Dependencies**: Detects and prevents circular reference chains
4. **Dependency Resolution**: Ensures all referenced dependencies exist

### Auto-Fixing Behavior

When inconsistencies are found, `validate` automatically:

- Adds missing child dependencies to parent plans
- Removes orphaned dependencies from parent plans
- Reports all changes made
- Preserves existing dependencies and metadata

Example output:

```
✓ Validated 15 plan files
⚠ Found 2 inconsistencies:
  - Added child-plan-123 to parent auth-system-456 dependencies
  - Removed orphaned dependency old-child-999 from parent auth-system-456
✓ All inconsistencies fixed automatically
```

## Best Practices

### 1. Plan Organization

**Use clear naming conventions:**

```bash
# Good: Clear, descriptive names
tim add "User Authentication - Phase 1: Database Setup"
tim add "User Authentication - Phase 2: API Implementation"

# Avoid: Vague or unclear names
tim add "Part 1"
tim add "TODO Items"
```

**Organize files logically:**

```
tasks/
├── auth-system/
│   ├── auth-root.yml
│   ├── phase-1-foundation.yml
│   ├── phase-2-features.yml
│   └── components/
│       ├── db-schema.yml
│       ├── api-endpoints.yml
│       └── frontend.yml
└── other-features/
```

### 2. Dependency Design

**Keep dependencies linear when possible:**

```yaml
# Good: Clear linear progression
Database Schema → API Endpoints → Frontend → Testing
# Avoid: Complex webs when simpler alternatives exist
```

**Use appropriate priority levels:**

- `high`: Critical path items that block other work
- `medium`: Standard implementation tasks
- `low`: Nice-to-have features
- `maybe`: Optional items (excluded from `--next-ready` workflows)

### 3. Workflow Patterns

**Start with high-level planning:**

```bash
# 1. Create the overall project structure
tim add "E-commerce Platform" --output tasks/ecommerce-root.yml

# 2. Break into phases
tim add "Backend Services" --parent ecommerce-root --output tasks/backend.yml
tim add "Frontend Application" --parent ecommerce-root --output tasks/frontend.yml
tim add "Integration & Testing" --parent ecommerce-root --output tasks/integration.yml

# 3. Add detailed tasks to each phase as needed
tim add "Product Catalog API" --parent backend --output tasks/catalog-api.yml
tim add "Shopping Cart Service" --parent backend --depends-on catalog-api --output tasks/cart-service.yml
```

**Use the `--next-ready` workflow:**

```bash
# Find and work on the next ready dependency
tim show --next-ready ecommerce-root

# Automatically execute the next ready task
tim agent --next-ready ecommerce-root

# Continue until all dependencies are complete
```

### 4. Maintenance

**Regular validation:**

```bash
# Run before major changes
tim validate --verbose

# Include in CI/CD pipeline
tim validate --no-fix  # Fail if inconsistencies found
```

**Keep relationships simple:**

- Avoid deep nesting (>3 levels) when possible
- Prefer linear dependencies over complex webs
- Use clear, descriptive titles and IDs
- Document complex relationships in plan details

## Common Workflows

### Starting a New Multi-Phase Project

1. **Create the root plan:**

   ```bash
   tim add "My New Feature" --priority high --output tasks/my-feature.yml
   ```

2. **Break into phases:**

   ```bash
   tim add "Phase 1: Foundation" --parent my-feature --output tasks/phase-1.yml
   tim add "Phase 2: Implementation" --parent my-feature --depends-on phase-1 --output tasks/phase-2.yml
   tim add "Phase 3: Testing" --parent my-feature --depends-on phase-2 --output tasks/phase-3.yml
   ```

3. **Add detailed tasks:**

   ```bash
   tim add "Database Setup" --parent phase-1 --output tasks/db-setup.yml
   tim add "API Framework" --parent phase-1 --depends-on db-setup --output tasks/api-framework.yml
   ```

4. **Validate and execute:**
   ```bash
   tim validate
   tim agent --next-ready my-feature
   ```

### Refactoring Existing Plans

1. **Assess current structure:**

   ```bash
   tim list --all
   tim show existing-plan.yml
   ```

2. **Create new parent if needed:**

   ```bash
   tim add "Refactored Project Structure" --output tasks/new-parent.yml
   ```

3. **Update relationships:**

   ```bash
   tim set existing-child-1.yml --parent new-parent
   tim set existing-child-2.yml --parent new-parent
   ```

4. **Validate changes:**
   ```bash
   tim validate --verbose
   ```

## Troubleshooting

### Common Issues

**Circular Dependencies:**

```
Error: Circular dependency detected: plan-a → plan-b → plan-c → plan-a
```

Solution: Review your dependency chain and break the circle by removing one dependency.

**Missing Parent Plans:**

```
Warning: Parent plan 'missing-parent' not found for child 'child-plan'
```

Solution: Either create the missing parent plan or update the child to reference an existing parent.

**Inconsistent Dependencies:**

```
Warning: Parent 'parent-plan' doesn't include child 'child-plan' in dependencies
```

Solution: Run `tim validate` to automatically fix the inconsistency.

### Debugging Commands

```bash
# See detailed plan information
tim show plan.yml --verbose

# Check dependency resolution
tim list --status all --sort dependencies

# Validate with full output
tim validate --verbose --no-fix
```

## Advanced Features

### Conditional Dependencies

While tim doesn't have built-in conditional logic, you can model complex scenarios using priority levels and manual dependency management:

```yaml
# High-priority critical path
id: critical-feature
priority: high
dependencies: [foundation-task]

# Lower-priority optional feature
id: optional-feature
priority: low
dependencies: [critical-feature]  # Only after critical path

# Maybe-priority (excluded from auto-workflows)
id: nice-to-have
priority: maybe
dependencies: [optional-feature]
```

### Integration with External Tools

Parent-child relationships work seamlessly with:

- **GitHub Issues**: Import issues as child plans of a parent project
- **Linear Integration**: Create hierarchical structures from Linear project data
- **Workspace Isolation**: Each plan in a hierarchy can run in its own workspace
- **CI/CD Integration**: Validate relationships in your build pipeline

## Conclusion

Parent-child relationships in tim provide a powerful way to organize complex projects while maintaining consistency automatically. By following these patterns and best practices, you can create maintainable, scalable project structures that grow with your needs.

For additional help:

- Run `tim --help` for command-specific documentation
- Use `tim validate --verbose` to understand relationship issues
- Check the main README for usage examples and configuration options
